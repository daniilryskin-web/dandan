#include "LigaBattle.h"

#include "LigaData.h"

namespace
{
	constexpr float GExpRate = 1.5f;
	const TCHAR* GStruggle = TEXT("struggle");

	const FLigaMove& MoveOrStruggle(const FString& Id)
	{
		const FLigaMove* M = FLigaDatabase::Get().Move(Id);
		if (!M) M = FLigaDatabase::Get().Move(GStruggle);
		check(M);
		return *M;
	}
}

// ———————————————————————————————— helpers ————————————————————————————————

float FLigaBattle::StageMult(int32 Stage)
{
	return Stage >= 0 ? (2.f + Stage) / 2.f : 2.f / (2.f - Stage);
}

float FLigaBattle::AccMult(int32 Stage)
{
	const int32 S = FMath::Clamp(Stage, -6, 6);
	return S >= 0 ? (3.f + S) / 3.f : 3.f / (3.f - S);
}

FString FLigaBattle::Label(ELigaSide Side)
{
	const FString Name = LigaRules::DisplayName(Mon(Side));
	if (Side == ELigaSide::Player) return Name;
	return bWild ? FString::Printf(TEXT("Дикий %s"), *Name) : FString::Printf(TEXT("%s соперника"), *Name);
}

void FLigaBattle::Say(const FString& Text)
{
	FLigaBattleEvent& E = Events.AddDefaulted_GetRef();
	E.T = ELigaEvent::Msg;
	E.Text = Text;
}

FLigaBattleEvent& FLigaBattle::Push(ELigaEvent T, ELigaSide Side)
{
	FLigaBattleEvent& E = Events.AddDefaulted_GetRef();
	E.T = T;
	E.Side = Side;
	return E;
}

float FLigaBattle::EffectiveSpeed(ELigaSide Side)
{
	const FLigaPokemon& P = Mon(Side);
	const float Base = LigaRules::CalcStat(P, ST_Spe) * StageMult(Stages[Idx(Side)][BS_Spe]);
	return P.GetStatus() == EStatus::Paralysis ? Base * 0.5f : Base;
}

bool FLigaBattle::StatusImmune(const FLigaPokemon& P, EStatus S) const
{
	const TArray<EPokeType> Types = LigaRules::TypesOf(P);
	switch (S)
	{
	case EStatus::Burn: return Types.Contains(EPokeType::Fire);
	case EStatus::Poison: return Types.Contains(EPokeType::Poison) || Types.Contains(EPokeType::Steel);
	case EStatus::Paralysis: return Types.Contains(EPokeType::Electric);
	case EStatus::Freeze: return Types.Contains(EPokeType::Ice);
	default: return false;
	}
}

bool FLigaBattle::InflictStatus(ELigaSide Side, EStatus S, bool bFromStatusMove)
{
	FLigaPokemon& P = Mon(Side);
	const FString Name = Label(Side);
	if (P.GetStatus() != EStatus::None || StatusImmune(P, S))
	{
		if (bFromStatusMove)
		{
			Say(P.GetStatus() != EStatus::None ? FString::Printf(TEXT("%s уже под действием статуса."), *Name)
			                                   : FString::Printf(TEXT("%s не поддаётся этому эффекту."), *Name));
		}
		return false;
	}
	P.SetStatus(S);
	if (S == EStatus::Sleep) P.SleepTurns = Rng.RandRange(1, 3);
	Push(ELigaEvent::Status, Side).Status = S;
	const TCHAR* Verb = TEXT("");
	switch (S)
	{
	case EStatus::Burn: Verb = TEXT("получает ожог!"); break;
	case EStatus::Poison: Verb = TEXT("отравлен!"); break;
	case EStatus::Paralysis: Verb = TEXT("парализован! Ему трудно двигаться."); break;
	case EStatus::Sleep: Verb = TEXT("засыпает!"); break;
	case EStatus::Freeze: Verb = TEXT("заморожен!"); break;
	default: break;
	}
	Say(FString::Printf(TEXT("%s %s"), *Name, Verb));
	return true;
}

void FLigaBattle::ChangeStages(ELigaSide Side, const int32* Changes)
{
	const FString Name = Label(Side);
	for (int32 K = 0; K < BS_Count; ++K)
	{
		const int32 Delta = Changes[K];
		if (Delta == 0) continue;
		int32& St = Stages[Idx(Side)][K];
		const int32 Before = St;
		St = FMath::Clamp(Before + Delta, -6, 6);
		const int32 Real = St - Before;
		if (Real == 0)
		{
			Say(FString::Printf(TEXT("%s: %s больше не может %s."), *Name, *LigaTypes::BattleStatName(K), Delta > 0 ? TEXT("расти") : TEXT("падать")));
			continue;
		}
		FLigaBattleEvent& E = Push(ELigaEvent::Stat, Side);
		E.Stat = K;
		E.Delta = Real;
		const TCHAR* How = Real >= 2 ? TEXT("сильно повышается") : Real > 0 ? TEXT("повышается") : Real <= -2 ? TEXT("сильно понижается") : TEXT("понижается");
		Say(FString::Printf(TEXT("%s: %s %s!"), *Name, *LigaTypes::BattleStatName(K), How));
	}
}

int32 FLigaBattle::ApplyDamage(ELigaSide Side, int32 Amount, float Eff, bool bCrit)
{
	FLigaPokemon& P = Mon(Side);
	const int32 Dealt = FMath::Min(P.HP, FMath::Max(0, Amount));
	P.HP -= Dealt;
	FLigaBattleEvent& E = Push(ELigaEvent::Damage, Side);
	E.Amount = Dealt;
	E.Hp = P.HP;
	E.Eff = Eff;
	E.bCrit = bCrit;
	return Dealt;
}

int32 FLigaBattle::ApplyHeal(ELigaSide Side, int32 Amount)
{
	FLigaPokemon& P = Mon(Side);
	const int32 Healed = FMath::Min(LigaRules::MaxHp(P) - P.HP, FMath::Max(0, Amount));
	if (Healed > 0)
	{
		P.HP += Healed;
		FLigaBattleEvent& E = Push(ELigaEvent::Heal, Side);
		E.Amount = Healed;
		E.Hp = P.HP;
	}
	return Healed;
}

int32 FLigaBattle::ComputeDamage(const FLigaPokemon& Attacker, const FLigaPokemon& Defender, const FLigaMove& Move, const int32* AtkSt,
	const int32* DefSt, bool bCrit, float Roll, float& OutEff)
{
	OutEff = LigaTypes::Effectiveness(Move.Type, LigaRules::TypesOf(Defender));
	if (OutEff == 0.f) return 0;
	const int32 Fixed = Move.Effect.FixedDamage;
	if (Fixed != -1)
	{
		OutEff = 1.f;
		if (Fixed == -2) return Attacker.Level;
		if (Fixed == -3) return FMath::Max(1, Defender.HP / 2);
		return Fixed;
	}
	const bool bPhysical = Move.Category == EMoveCategory::Physical;
	int32 AStage = bPhysical ? AtkSt[BS_Atk] : AtkSt[BS_SpA];
	int32 DStage = bPhysical ? DefSt[BS_Def] : DefSt[BS_SpD];
	if (bCrit)
	{
		AStage = FMath::Max(0, AStage);
		DStage = FMath::Min(0, DStage);
	}
	const float A = LigaRules::CalcStat(Attacker, bPhysical ? ST_Atk : ST_SpA) * StageMult(AStage);
	const float D = FMath::Max(1.f, LigaRules::CalcStat(Defender, bPhysical ? ST_Def : ST_SpD) * StageMult(DStage));
	const int32 Power = Move.Power * (Move.Effect.bHex && Defender.GetStatus() != EStatus::None ? 2 : 1);
	const float LevelPart = FMath::FloorToFloat(2.f * Attacker.Level / 5.f + 2.f);
	const float Base = FMath::FloorToFloat(FMath::FloorToFloat(LevelPart * Power * A / D) / 50.f) + 2.f;
	const float Stab = LigaRules::TypesOf(Attacker).Contains(Move.Type) ? 1.5f : 1.f;
	const float Burn = bPhysical && Attacker.GetStatus() == EStatus::Burn ? 0.5f : 1.f;
	const float Random = 0.85f + Roll * 0.15f;
	return FMath::Max(1, (int32)FMath::FloorToFloat(Base * Random * Stab * OutEff * (bCrit ? 1.5f : 1.f) * Burn));
}

int32 FLigaBattle::MultiHitCount(int32 Lo, int32 Hi)
{
	if (Lo == Hi) return Lo;
	const float R = Rng.FRand();
	if (R < 0.35f) return 2;
	if (R < 0.7f) return 3;
	if (R < 0.85f) return 4;
	return FMath::Min(Hi, 5);
}

void FLigaBattle::Confuse(ELigaSide Side, bool bFromStatusMove)
{
	FLigaVolatile& V = Vol[Idx(Side)];
	if (V.Confused > 0)
	{
		if (bFromStatusMove) Say(FString::Printf(TEXT("%s уже в замешательстве."), *Label(Side)));
		return;
	}
	V.Confused = Rng.RandRange(2, 5);
	Push(ELigaEvent::Confuse, Side);
	Say(FString::Printf(TEXT("%s приходит в замешательство!"), *Label(Side)));
}

void FLigaBattle::SelfKnockOut(ELigaSide Side)
{
	if (Mon(Side).HP > 0) ApplyDamage(Side, Mon(Side).HP, 1.f, false);
}

// ———————————————————————————————— moves ————————————————————————————————

void FLigaBattle::UseMove(ELigaSide Side, int32 SlotIndex, bool bMovedFirst)
{
	FLigaPokemon& Attacker = Mon(Side);
	const ELigaSide DefSide = Other(Side);
	FLigaPokemon& Defender = Mon(DefSide);
	const FString Name = Label(Side);
	FLigaVolatile& V = Vol[Idx(Side)];

	if (V.bRecharge)
	{
		V.bRecharge = false;
		Say(FString::Printf(TEXT("%s восстанавливает силы после мощной атаки."), *Name));
		return;
	}
	if (Attacker.GetStatus() == EStatus::Freeze)
	{
		if (Rng.FRand() < 0.2f)
		{
			Attacker.SetStatus(EStatus::None);
			Push(ELigaEvent::Status, Side).Status = EStatus::None;
			Say(FString::Printf(TEXT("%s оттаивает!"), *Name));
		}
		else
		{
			Say(FString::Printf(TEXT("%s заморожен и не может двигаться!"), *Name));
			return;
		}
	}
	if (Attacker.GetStatus() == EStatus::Sleep)
	{
		Attacker.SleepTurns -= 1;
		if (Attacker.SleepTurns > 0)
		{
			Say(FString::Printf(TEXT("%s крепко спит."), *Name));
			return;
		}
		Attacker.SetStatus(EStatus::None);
		Attacker.SleepTurns = 0;
		Push(ELigaEvent::Status, Side).Status = EStatus::None;
		Say(FString::Printf(TEXT("%s просыпается!"), *Name));
	}
	if (Flinch[Idx(Side)])
	{
		Say(FString::Printf(TEXT("%s дрогнул и не смог атаковать!"), *Name));
		return;
	}
	if (V.Confused > 0)
	{
		V.Confused -= 1;
		if (V.Confused == 0)
		{
			Say(FString::Printf(TEXT("%s больше не в замешательстве!"), *Name));
		}
		else
		{
			Say(FString::Printf(TEXT("%s в замешательстве..."), *Name));
			if (Rng.FRand() < 1.f / 3.f)
			{
				const float A = LigaRules::CalcStat(Attacker, ST_Atk) * StageMult(Stages[Idx(Side)][BS_Atk]);
				const float D = FMath::Max(1.f, LigaRules::CalcStat(Attacker, ST_Def) * StageMult(Stages[Idx(Side)][BS_Def]));
				const float LevelPart = FMath::FloorToFloat(2.f * Attacker.Level / 5.f + 2.f);
				const int32 Dmg = FMath::Max(1, (int32)(FMath::FloorToFloat(FMath::FloorToFloat(LevelPart * 40.f * A / D) / 50.f) + 2.f));
				ApplyDamage(Side, Dmg, 1.f, false);
				Events.Last().MoveId = TEXT("status:confusion");  // tells the battle stage which effect to show
				Say(FString::Printf(TEXT("%s бьёт сам себя в замешательстве!"), *Name));
				return;
			}
		}
	}
	if (Attacker.GetStatus() == EStatus::Paralysis && Rng.FRand() < 0.25f)
	{
		Say(FString::Printf(TEXT("%s парализован и не может двигаться!"), *Name));
		return;
	}

	FString MoveId;
	if (SlotIndex < 0 || !Attacker.Moves.IsValidIndex(SlotIndex))
	{
		MoveId = GStruggle;
		Say(FString::Printf(TEXT("%s: не осталось PP!"), *Name));
	}
	else
	{
		FLigaMoveSlot& Slot = Attacker.Moves[SlotIndex];
		Slot.PP = FMath::Max(0, Slot.PP - 1);
		MoveId = Slot.Id;
	}
	const FLigaMove& Move = MoveOrStruggle(MoveId);
	Push(ELigaEvent::Move, Side).MoveId = Move.Id;
	Say(FString::Printf(TEXT("%s использует «%s»!"), *Name, *Move.Name));
	const FLigaMoveEffect& Fx = Move.Effect;
	if (!Fx.bProtect) V.ProtectStreak = 0;

	if (Fx.bFlee)
	{
		if (bWild)
		{
			Say(Side == ELigaSide::Player ? FString::Printf(TEXT("%s телепортируется прочь!"), *Name) : FString::Printf(TEXT("%s исчезает!"), *Name));
			Finish(ELigaBattleResult::Fled);
		}
		else
		{
			Say(TEXT("Но ничего не произошло!"));
		}
		return;
	}

	const bool bTargetsFoe = Move.Category != EMoveCategory::Status || Fx.Status != EStatus::None || Fx.ConfuseChance > 0 || (Fx.bHasStats && !Fx.bStatsSelf);
	if (bTargetsFoe && Vol[Idx(DefSide)].bProtected)
	{
		Say(FString::Printf(TEXT("%s защищается!"), *Label(DefSide)));
		if (Fx.bSelfKO) SelfKnockOut(Side);
		return;
	}
	if (Fx.bOHKO)
	{
		if (Attacker.Level < Defender.Level || LigaTypes::Effectiveness(Move.Type, LigaRules::TypesOf(Defender)) == 0.f)
		{
			Say(TEXT("Но ничего не произошло!"));
			return;
		}
		if (Rng.FRand() * 100.f >= 30 + Attacker.Level - Defender.Level)
		{
			Push(ELigaEvent::Miss, Side);
			Say(FString::Printf(TEXT("%s промахивается!"), *Name));
			return;
		}
		ApplyDamage(DefSide, Defender.HP, 1.f, false);
		Events.Last().MoveId = Move.Id;
		Say(TEXT("Сокрушительный удар — одним махом!"));
		return;
	}
	if (bTargetsFoe && Move.Accuracy >= 0)
	{
		const float Acc = Move.Accuracy * AccMult(Stages[Idx(Side)][BS_Acc] - Stages[Idx(DefSide)][BS_Eva]);
		if (Rng.FRand() * 100.f >= Acc)
		{
			Push(ELigaEvent::Miss, Side);
			Say(FString::Printf(TEXT("%s промахивается!"), *Name));
			if (Fx.bSelfKO) SelfKnockOut(Side);
			return;
		}
	}

	if (Move.Category == EMoveCategory::Status)
	{
		RunStatusMove(Side, Move);
		return;
	}

	const FString DefName = Label(DefSide);
	const float Eff = LigaTypes::Effectiveness(Move.Type, LigaRules::TypesOf(Defender));
	if (Eff == 0.f)
	{
		Say(FString::Printf(TEXT("%s неуязвим к этой атаке!"), *DefName));
		if (Fx.bSelfKO) SelfKnockOut(Side);
		return;
	}
	const int32 Hits = Fx.MultiHitMax > 0 ? MultiHitCount(Fx.MultiHitMin, Fx.MultiHitMax) : 1;
	int32 Total = 0;
	int32 Landed = 0;
	bool bAnyCrit = false;
	for (int32 i = 0; i < Hits; ++i)
	{
		if (Defender.HP <= 0) break;
		const bool bCrit = Fx.FixedDamage == -1 && Rng.FRand() < (Fx.bHighCrit ? 1.f / 8.f : 1.f / 24.f);
		float E = 1.f;
		const int32 Dmg = ComputeDamage(Attacker, Defender, Move, Stages[Idx(Side)], Stages[Idx(DefSide)], bCrit, Rng.FRand(), E);
		Total += ApplyDamage(DefSide, Dmg, Eff, bCrit);
		Events.Last().MoveId = Move.Id;
		++Landed;
		bAnyCrit |= bCrit;
	}
	if (bAnyCrit) Say(TEXT("Критический удар!"));
	if (Fx.FixedDamage == -1)
	{
		if (Eff >= 2.f) Say(TEXT("Это очень эффективно!"));
		else if (Eff < 1.f) Say(TEXT("Это не очень эффективно..."));
	}
	if (Hits > 1) Say(FString::Printf(TEXT("Нанесено ударов: %d."), Landed));

	if (Fx.Drain > 0.f && Total > 0)
	{
		if (ApplyHeal(Side, FMath::Max(1, (int32)(Total * Fx.Drain))) > 0)
		{
			Say(FString::Printf(TEXT("%s теряет силы, а %s восстанавливает здоровье."), *DefName, *Name));
		}
	}
	if (Fx.Recoil > 0.f && Total > 0)
	{
		ApplyDamage(Side, FMath::Max(1, (int32)(Total * Fx.Recoil)), 1.f, false);
		Events.Last().MoveId = TEXT("recoil");
		Say(FString::Printf(TEXT("%s получает урон от отдачи!"), *Name));
	}
	if (Fx.bPayDay && Side == ELigaSide::Player)
	{
		PayDay += Attacker.Level * 5;
		Say(TEXT("Вокруг рассыпаются монетки!"));
	}
	if (Defender.GetStatus() == EStatus::Freeze && Move.Type == EPokeType::Fire && Defender.HP > 0)
	{
		Defender.SetStatus(EStatus::None);
		Push(ELigaEvent::Status, DefSide).Status = EStatus::None;
		Say(FString::Printf(TEXT("%s оттаивает!"), *DefName));
	}
	if (Defender.HP > 0)
	{
		if (Fx.Status != EStatus::None && Chance(Fx.StatusChance)) InflictStatus(DefSide, Fx.Status, false);
		if (Fx.ConfuseChance > 0 && Chance(Fx.ConfuseChance)) Confuse(DefSide, false);
		if (Fx.bHasStats && !Fx.bStatsSelf && Chance(Fx.StatsChance)) ChangeStages(DefSide, Fx.StatChanges);
		if (Fx.Flinch > 0 && bMovedFirst && Chance(Fx.Flinch)) Flinch[Idx(DefSide)] = true;
	}
	if (Fx.bHasStats && Fx.bStatsSelf && Attacker.HP > 0 && Chance(Fx.StatsChance)) ChangeStages(Side, Fx.StatChanges);
	if (Fx.bRecharge && Attacker.HP > 0) V.bRecharge = true;
	if (Fx.bSelfKO) SelfKnockOut(Side);
}

void FLigaBattle::RunStatusMove(ELigaSide Side, const FLigaMove& Move)
{
	const FLigaMoveEffect& Fx = Move.Effect;
	FLigaPokemon& User = Mon(Side);
	const FString Name = Label(Side);
	const ELigaSide DefSide = Other(Side);
	FLigaPokemon& Target = Mon(DefSide);

	if (Fx.bRest)
	{
		if (User.HP >= LigaRules::MaxHp(User))
		{
			Say(TEXT("Но ничего не произошло!"));
			return;
		}
		ApplyHeal(Side, LigaRules::MaxHp(User));
		User.SetStatus(EStatus::Sleep);
		User.SleepTurns = 3;
		Push(ELigaEvent::Status, Side).Status = EStatus::Sleep;
		Say(FString::Printf(TEXT("%s засыпает и восстанавливает здоровье!"), *Name));
		return;
	}
	if (Fx.Heal > 0.f)
	{
		const int32 Healed = ApplyHeal(Side, (int32)(LigaRules::MaxHp(User) * Fx.Heal));
		Say(Healed > 0 ? FString::Printf(TEXT("%s восстанавливает здоровье!"), *Name) : FString(TEXT("Но ничего не произошло!")));
		return;
	}
	if (Fx.bProtect)
	{
		FLigaVolatile& V = Vol[Idx(Side)];
		if (Rng.FRand() < 1.f / FMath::Pow(3.f, (float)V.ProtectStreak))
		{
			V.bProtected = true;
			V.ProtectStreak += 1;
			Push(ELigaEvent::Protect, Side);
			Say(FString::Printf(TEXT("%s готовится защищаться!"), *Name));
		}
		else
		{
			V.ProtectStreak = 0;
			Say(TEXT("Но ничего не вышло!"));
		}
		return;
	}
	if (Fx.ConfuseChance > 0 && Fx.Status == EStatus::None && !Fx.bHasStats)
	{
		Confuse(DefSide, true);
		return;
	}
	if (Fx.Status != EStatus::None)
	{
		const TArray<EPokeType> TT = LigaRules::TypesOf(Target);
		const bool bPowder = Move.Id.Contains(TEXT("powder")) || Move.Id == TEXT("spore");
		if (LigaTypes::Effectiveness(Move.Type, TT) == 0.f || (bPowder && TT.Contains(EPokeType::Grass)))
		{
			Say(FString::Printf(TEXT("%s не поддаётся этому эффекту."), *Label(DefSide)));
			return;
		}
		InflictStatus(DefSide, Fx.Status, true);
		return;
	}
	if (Fx.bHasStats)
	{
		ChangeStages(Fx.bStatsSelf ? Side : DefSide, Fx.StatChanges);
		if (Fx.ConfuseChance > 0) Confuse(DefSide, false);
		return;
	}
	Say(TEXT("Но ничего не произошло!"));
}

// ———————————————————————————————— AI ————————————————————————————————

int32 FLigaBattle::ChooseEnemyMove()
{
	FLigaPokemon& Enemy = EnemyMon();
	const FLigaPokemon& Target = PlayerMon();
	TArray<int32> Usable;
	for (int32 i = 0; i < Enemy.Moves.Num(); ++i)
	{
		if (Enemy.Moves[i].PP > 0) Usable.Add(i);
	}
	if (Usable.Num() == 0) return -1;
	if (bWild) return Usable[Rng.RandRange(0, Usable.Num() - 1)];

	const TArray<EPokeType> EnemyTypes = LigaRules::TypesOf(Enemy);
	const TArray<EPokeType> TargetTypes = LigaRules::TypesOf(Target);
	int32 Best = Usable[0];
	float BestScore = -1.f;
	for (int32 i : Usable)
	{
		const FLigaMove& Mv = MoveOrStruggle(Enemy.Moves[i].Id);
		float Score = 0.f;
		if (Mv.Effect.bOHKO) Score = Enemy.Level >= Target.Level ? 40.f : 0.f;
		else if (Mv.Category == EMoveCategory::Status)
		{
			if (Mv.Effect.bProtect) Score = 8.f;
			else if (Mv.Effect.Status != EStatus::None) Score = Target.GetStatus() != EStatus::None ? 0.f : 45.f;
			else if (Mv.Effect.Heal > 0.f || Mv.Effect.bRest) Score = Enemy.HP < LigaRules::MaxHp(Enemy) * 0.4f ? 80.f : 0.f;
			else Score = Turn <= 2 ? 25.f : 5.f;
		}
		else if (Mv.Effect.FixedDamage != -1)
		{
			Score = Mv.Effect.FixedDamage == -2 ? Enemy.Level * 1.2f : Mv.Effect.FixedDamage == -3 ? Target.HP / 2.f : (float)Mv.Effect.FixedDamage;
		}
		else
		{
			const float Eff = LigaTypes::Effectiveness(Mv.Type, TargetTypes);
			Score = Mv.Power * Eff * (EnemyTypes.Contains(Mv.Type) ? 1.5f : 1.f) * ((Mv.Accuracy < 0 ? 100.f : Mv.Accuracy) / 100.f);
		}
		if (Score > BestScore)
		{
			BestScore = Score;
			Best = i;
		}
	}
	if (Rng.FRand() < 0.75f && BestScore > 0.f) return Best;
	return Usable[Rng.RandRange(0, Usable.Num() - 1)];
}

// ———————————————————————————————— start / turn ————————————————————————————————

TUniquePtr<FLigaBattle> FLigaBattle::StartWild(FLigaGameData& Game, int32 Species, int32 Level, const FString& Place, int32 Seed)
{
	const int32 Active = Game.FirstAliveIndex();
	if (Active == INDEX_NONE || !FLigaDatabase::Get().Species(Species)) return nullptr;
	TUniquePtr<FLigaBattle> B = MakeUnique<FLigaBattle>();
	B->Game = &Game;
	B->bWild = true;
	B->Place = Place;
	B->Rng.Initialize(Seed);
	B->PlayerActive = Active;
	FLigaPokemon Enemy = LigaRules::CreatePokemon(Species, Level, B->Rng, Game.NextUid++);
	Enemy.MetAt = Place;
	B->EnemyTeam.Add(Enemy);
	B->Participants.Add(Game.Team[Active].Uid);
	Game.MarkSeen(Species);
	Game.Encounters++;
	B->Say(FString::Printf(TEXT("Дикий %s (ур. %d) нападает!"), *LigaRules::DisplayName(Enemy), Level));
	if (Enemy.bShiny) B->Say(TEXT("✨ Он сияет! Это шайни-покемон!"));
	B->Say(FString::Printf(TEXT("Вперёд, %s!"), *LigaRules::DisplayName(Game.Team[Active])));
	return B;
}

TUniquePtr<FLigaBattle> FLigaBattle::StartTrainer(FLigaGameData& Game, const FString& Trainer, const TArray<FIntPoint>& Team, int32 InPrize,
	const FString& InPlace, int32 Seed)
{
	const int32 Active = Game.FirstAliveIndex();
	if (Active == INDEX_NONE) return nullptr;
	TUniquePtr<FLigaBattle> B = MakeUnique<FLigaBattle>();
	B->Game = &Game;
	B->bWild = false;
	B->TrainerName = Trainer;
	B->Prize = FMath::Max(0, InPrize);
	B->Place = InPlace;
	B->Rng.Initialize(Seed);
	B->PlayerActive = Active;
	for (const FIntPoint& Member : Team)
	{
		if (!FLigaDatabase::Get().Species(Member.X)) continue;
		FLigaPokemon Pk = LigaRules::CreatePokemon(Member.X, FMath::Clamp(Member.Y, 1, LigaRules::MaxLevel), B->Rng, Game.NextUid++, 0);
		Pk.MetAt = InPlace;
		B->EnemyTeam.Add(Pk);
	}
	if (B->EnemyTeam.Num() == 0) return nullptr;
	B->Participants.Add(Game.Team[Active].Uid);
	Game.MarkSeen(B->EnemyTeam[0].Species);
	B->Say(FString::Printf(TEXT("%s вызывает вас на бой!"), *Trainer));
	B->Say(FString::Printf(TEXT("%s выпускает покемона: %s (ур. %d)!"), *Trainer, *LigaRules::DisplayName(B->EnemyTeam[0]), B->EnemyTeam[0].Level));
	B->Say(FString::Printf(TEXT("Вперёд, %s!"), *LigaRules::DisplayName(Game.Team[Active])));
	return B;
}

bool FLigaBattle::DoTurn(const FLigaBattleAction& Action, FString& OutError)
{
	if (Phase != ELigaBattlePhase::Choose)
	{
		OutError = TEXT("Сейчас нельзя действовать");
		return false;
	}
	Events.Reset();
	Flinch[0] = Flinch[1] = false;

	if (Action.Kind == FLigaBattleAction::Item)
	{
		const FLigaItem* Item = FLigaDatabase::Get().Item(Action.ItemId);
		if (!Item || Game->ItemCount(Action.ItemId) <= 0)
		{
			OutError = TEXT("Нет такого предмета");
			return false;
		}
		if (Item->Kind == TEXT("ball") && !bWild)
		{
			Say(TEXT("Нельзя ловить покемонов другого тренера!"));
			return true;
		}
	}
	if (Action.Kind == FLigaBattleAction::Run && !bWild)
	{
		Say(TEXT("Из боя с тренером нельзя сбежать!"));
		return true;
	}
	if (Action.Kind == FLigaBattleAction::Switch)
	{
		if (!Game->Team.IsValidIndex(Action.Index) || Game->Team[Action.Index].IsFainted() || Action.Index == PlayerActive)
		{
			OutError = TEXT("Нельзя выпустить этого покемона");
			return false;
		}
	}
	int32 PlayerChoice = 0;
	if (Action.Kind == FLigaBattleAction::Move)
	{
		const FLigaPokemon& P = PlayerMon();
		const bool bAllEmpty = !P.Moves.ContainsByPredicate([](const FLigaMoveSlot& M) { return M.PP > 0; });
		if (!bAllEmpty && (!P.Moves.IsValidIndex(Action.Index) || P.Moves[Action.Index].PP <= 0))
		{
			OutError = TEXT("У этой атаки не осталось PP");
			return false;
		}
		PlayerChoice = bAllEmpty ? -1 : Action.Index;
	}

	Turn += 1;
	const int32 EnemyChoice = ChooseEnemyMove();
	auto EnemyActs = [this, EnemyChoice]()
	{
		if (Phase != ELigaBattlePhase::Choose) return;
		if (EnemyMon().HP <= 0 || PlayerMon().HP <= 0) return;
		UseMove(ELigaSide::Enemy, EnemyChoice, false);
	};

	switch (Action.Kind)
	{
	case FLigaBattleAction::Run:
		if (!TryRun()) EnemyActs();
		break;
	case FLigaBattleAction::Switch:
		SwitchPlayer(Action.Index);
		EnemyActs();
		break;
	case FLigaBattleAction::Item:
	{
		const FLigaItem* Item = FLigaDatabase::Get().Item(Action.ItemId);
		if (Item->Kind == TEXT("ball"))
		{
			if (!ThrowBall(Action.ItemId)) EnemyActs();
		}
		else
		{
			UseBattleItem(Action.ItemId, Action.TargetUid ? Action.TargetUid : PlayerMon().Uid);
			EnemyActs();
		}
		break;
	}
	case FLigaBattleAction::Move:
	{
		const FLigaPokemon& P = PlayerMon();
		const FLigaMove& PMove = MoveOrStruggle(PlayerChoice >= 0 ? P.Moves[PlayerChoice].Id : FString(GStruggle));
		const FLigaMove& EMove = MoveOrStruggle(EnemyChoice >= 0 ? EnemyMon().Moves[EnemyChoice].Id : FString(GStruggle));
		ELigaSide Order[2] = {ELigaSide::Player, ELigaSide::Enemy};
		bool bPlayerFirst;
		if (PMove.Priority != EMove.Priority) bPlayerFirst = PMove.Priority > EMove.Priority;
		else
		{
			const float PS = EffectiveSpeed(ELigaSide::Player);
			const float ES = EffectiveSpeed(ELigaSide::Enemy);
			bPlayerFirst = PS == ES ? Rng.FRand() < 0.5f : PS > ES;
		}
		if (!bPlayerFirst) Swap(Order[0], Order[1]);
		for (int32 i = 0; i < 2; ++i)
		{
			if (Phase != ELigaBattlePhase::Choose) break;
			if (PlayerMon().HP <= 0 || EnemyMon().HP <= 0) break;
			UseMove(Order[i], Order[i] == ELigaSide::Player ? PlayerChoice : EnemyChoice, i == 0);
		}
		break;
	}
	}

	if (Phase == ELigaBattlePhase::Choose) EndOfTurn();
	if (Phase == ELigaBattlePhase::Choose) ResolveFaints();
	return true;
}

bool FLigaBattle::TryRun()
{
	RunAttempts += 1;
	const float PS = EffectiveSpeed(ELigaSide::Player);
	const float ES = EffectiveSpeed(ELigaSide::Enemy);
	const float Odds = PS >= ES ? 256.f : FMath::FloorToFloat(PS * 128.f / FMath::Max(1.f, ES)) + 30.f * RunAttempts;
	if (Rng.FRand() * 256.f < Odds)
	{
		Say(TEXT("Вы благополучно сбежали!"));
		Finish(ELigaBattleResult::Fled);
		return true;
	}
	Say(TEXT("Сбежать не удалось!"));
	return false;
}

void FLigaBattle::SwitchPlayer(int32 Index)
{
	const FLigaPokemon& Prev = PlayerMon();
	const bool bPrevAlive = Prev.HP > 0;
	const FString PrevName = LigaRules::DisplayName(Prev);
	PlayerActive = Index;
	FMemory::Memzero(Stages[0]);
	Vol[0] = FLigaVolatile();
	const FLigaPokemon& Next = PlayerMon();
	Participants.AddUnique(Next.Uid);
	if (bPrevAlive) Say(FString::Printf(TEXT("%s, вернись!"), *PrevName));
	Push(ELigaEvent::Switch, ELigaSide::Player).Uid = Next.Uid;
	Say(FString::Printf(TEXT("Вперёд, %s!"), *LigaRules::DisplayName(Next)));
}

void FLigaBattle::UseBattleItem(const FString& ItemId, int32 TargetUid)
{
	FLigaPokemon* Target = Game->FindByUid(TargetUid);
	const FLigaItem* Item = FLigaDatabase::Get().Item(ItemId);
	if (!Target || !Item) return;
	FString Msg;
	int32 Healed = 0;
	bool bCured = false;
	if (!LigaApplyItem(*Target, ItemId, Msg, &Healed, &bCured))
	{
		Say(Msg);
		return;
	}
	Game->Bag.FindOrAdd(ItemId) -= 1;
	Say(FString::Printf(TEXT("Вы используете «%s». %s"), *Item->Name, *Msg));
	if (Target->Uid == PlayerMon().Uid)
	{
		if (Healed > 0)
		{
			FLigaBattleEvent& E = Push(ELigaEvent::Heal, ELigaSide::Player);
			E.Amount = Healed;
			E.Hp = Target->HP;
		}
		if (bCured) Push(ELigaEvent::Status, ELigaSide::Player).Status = EStatus::None;
	}
}

int32 FLigaBattle::CatchShakes(const FLigaPokemon& Target, float BallMult, FRandomStream& InRng)
{
	if (BallMult >= 255.f) return 4;
	const FLigaSpecies* S = LigaRules::SpeciesOf(Target);
	const float MHP = LigaRules::MaxHp(Target);
	const EStatus St = Target.GetStatus();
	const float StatusBonus = (St == EStatus::Sleep || St == EStatus::Freeze) ? 2.5f : St != EStatus::None ? 1.5f : 1.f;
	const float A = ((3.f * MHP - 2.f * Target.HP) * (S ? S->CatchRate : 45) * BallMult) / (3.f * MHP) * StatusBonus;
	if (A >= 255.f) return 4;
	const float B = 65536.f / FMath::Pow(255.f / FMath::Max(A, 0.01f), 0.1875f);
	int32 Shakes = 0;
	while (Shakes < 4 && InRng.FRand() * 65536.f < B) ++Shakes;
	return Shakes;
}

bool FLigaBattle::ThrowBall(const FString& BallId)
{
	const FLigaItem* Item = FLigaDatabase::Get().Item(BallId);
	FLigaPokemon& Target = EnemyMon();
	Game->Bag.FindOrAdd(BallId) -= 1;
	Say(FString::Printf(TEXT("Вы бросаете %s!"), *Item->Name));
	const int32 Shakes = CatchShakes(Target, Item->Ball, Rng);
	const bool bCaught = Shakes == 4;
	FLigaBattleEvent& E = Push(ELigaEvent::Ball, ELigaSide::Enemy);
	E.Ball = BallId;
	E.Shakes = FMath::Min(Shakes, 3);
	E.bCaught = bCaught;
	if (!bCaught)
	{
		static const TCHAR* Lines[] = {
			TEXT("О нет! Покемон вырвался!"), TEXT("Ах! Почти получилось!"), TEXT("Ох! Чуть-чуть не хватило!"), TEXT("Совсем немного не хватило!"),
		};
		Say(Lines[FMath::Min(Shakes, 3)]);
		return false;
	}
	const FString Name = LigaRules::DisplayName(Target);
	Say(FString::Printf(TEXT("Попался! %s пойман!"), *Name));
	Target.Ball = BallId;
	Target.MetAt = Place;
	Target.MetLevel = Target.Level;
	AwardExp(Target);
	Game->MarkCaught(Target.Species);
	Game->Caught++;
	if (Game->Team.Num() < LigaRules::MaxTeam)
	{
		Game->Team.Add(Target);
	}
	else
	{
		Game->Storage.Add(Target);
		Say(FString::Printf(TEXT("Команда заполнена — %s отправлен в компьютер."), *Name));
	}
	Finish(ELigaBattleResult::Caught);
	return true;
}

void FLigaBattle::EndOfTurn()
{
	Vol[0].bProtected = Vol[1].bProtected = false;
	for (ELigaSide Side : {ELigaSide::Player, ELigaSide::Enemy})
	{
		FLigaPokemon& P = Mon(Side);
		if (P.HP <= 0) continue;
		const EStatus S = P.GetStatus();
		if (S == EStatus::Burn || S == EStatus::Poison)
		{
			ApplyDamage(Side, FMath::Max(1, LigaRules::MaxHp(P) / (S == EStatus::Burn ? 16 : 8)), 1.f, false);
			Events.Last().MoveId = S == EStatus::Burn ? TEXT("status:burn") : TEXT("status:poison");
			Say(FString::Printf(TEXT("%s %s!"), *Label(Side), S == EStatus::Burn ? TEXT("страдает от ожога") : TEXT("страдает от яда")));
		}
	}
}

void FLigaBattle::ResolveFaints()
{
	FLigaPokemon& Enemy = EnemyMon();
	FLigaPokemon& Player = PlayerMon();
	if (Enemy.HP <= 0)
	{
		Push(ELigaEvent::Faint, ELigaSide::Enemy);
		Say(FString::Printf(TEXT("%s теряет сознание!"), *Label(ELigaSide::Enemy)));
		AwardExp(Enemy);
		if (bWild) Game->WildDefeated++;
		int32 Next = INDEX_NONE;
		for (int32 i = 0; i < EnemyTeam.Num(); ++i)
		{
			if (i != EnemyActive && EnemyTeam[i].HP > 0) { Next = i; break; }
		}
		if (Next == INDEX_NONE)
		{
			if (Player.HP <= 0) Push(ELigaEvent::Faint, ELigaSide::Player);
			Finish(ELigaBattleResult::Win);
			return;
		}
		EnemyActive = Next;
		FMemory::Memzero(Stages[1]);
		Vol[1] = FLigaVolatile();
		Participants.Reset();
		if (Player.HP > 0) Participants.Add(Player.Uid);
		Game->MarkSeen(EnemyMon().Species);
		Push(ELigaEvent::Switch, ELigaSide::Enemy).Uid = EnemyMon().Uid;
		Say(FString::Printf(TEXT("%s выпускает покемона: %s (ур. %d)!"), *TrainerName, *LigaRules::DisplayName(EnemyMon()), EnemyMon().Level));
	}
	if (Player.HP <= 0)
	{
		Push(ELigaEvent::Faint, ELigaSide::Player);
		Say(FString::Printf(TEXT("%s теряет сознание!"), *LigaRules::DisplayName(Player)));
		Participants.Remove(Player.Uid);
		if (Game->FirstAliveIndex() == INDEX_NONE)
		{
			Say(TEXT("У вас не осталось покемонов, способных сражаться..."));
			Finish(ELigaBattleResult::Lose);
			return;
		}
		Phase = ELigaBattlePhase::ForceSwitch;
	}
}

void FLigaBattle::AwardExp(const FLigaPokemon& Defeated)
{
	const FLigaSpecies* S = LigaRules::SpeciesOf(Defeated);
	if (!S) return;
	const int32 Total = (int32)FMath::FloorToFloat(S->BaseExp * Defeated.Level / 7.f * (bWild ? 1.f : 1.5f) * GExpRate);
	TArray<FLigaPokemon*> Alive;
	for (int32 Uid : Participants)
	{
		FLigaPokemon* P = Game->FindByUid(Uid);
		if (P && P->HP > 0) Alive.Add(P);
	}
	if (Alive.Num() == 0) return;
	const int32 Share = FMath::Max(1, Total / Alive.Num());
	for (FLigaPokemon* P : Alive)
	{
		if (P->Level >= LigaRules::MaxLevel) continue;
		LigaRules::AddEvYield(*P, Defeated.Species);
		const FLigaLevelUpResult Res = LigaRules::GainExp(*P, Share);
		FLigaBattleEvent& E = Push(ELigaEvent::Exp, ELigaSide::Player);
		E.Uid = P->Uid;
		E.Amount = Share;
		Say(FString::Printf(TEXT("%s получает %d опыта."), *LigaRules::DisplayName(*P), Share));
		for (int32 Lvl : Res.Levels)
		{
			FLigaBattleEvent& L = Push(ELigaEvent::LevelUp, ELigaSide::Player);
			L.Uid = P->Uid;
			L.Level = Lvl;
			Say(FString::Printf(TEXT("%s достигает уровня %d!"), *LigaRules::DisplayName(*P), Lvl));
		}
		for (const FString& Mv : Res.Learned)
		{
			FLigaBattleEvent& L = Push(ELigaEvent::Learn, ELigaSide::Player);
			L.Uid = P->Uid;
			L.MoveId = Mv;
			const FLigaMove* M = FLigaDatabase::Get().Move(Mv);
			Say(FString::Printf(TEXT("%s изучает «%s»!"), *LigaRules::DisplayName(*P), M ? *M->Name : *Mv));
		}
		for (const FString& Mv : Res.Pending) PendingLearn.Add({P->Uid, Mv});
		if (Res.Levels.Num() > 0) Leveled.AddUnique(P->Uid);
	}
}

void FLigaBattle::Finish(ELigaBattleResult R)
{
	Phase = ELigaBattlePhase::Ended;
	Result = R;
	if (R == ELigaBattleResult::Win && bWild)
	{
		const int32 Coins = EnemyTeam[0].Level * 4;
		Game->Money += Coins;
		Say(FString::Printf(TEXT("Вы нашли %d монет."), Coins));
	}
	if (R == ELigaBattleResult::Win && !bWild && Prize > 0)
	{
		Game->Money += Prize;
		Say(FString::Printf(TEXT("Вы победили: %s! Награда — %d монет."), *TrainerName, Prize));
	}
	if (R != ELigaBattleResult::Lose && PayDay > 0)
	{
		Game->Money += PayDay;
		Say(FString::Printf(TEXT("Вы подобрали %d монет."), PayDay));
	}
	if (R == ELigaBattleResult::Lose)
	{
		const int32 Lost = Game->Money / 10;
		Game->Money -= Lost;
		Say(FString::Printf(TEXT("Вы теряете %d монет и спешите домой..."), Lost));
	}
	Push(ELigaEvent::End, ELigaSide::Player).Result = R;
}

bool FLigaBattle::ForceSwitch(int32 TeamIndex, FString& OutError)
{
	if (Phase != ELigaBattlePhase::ForceSwitch)
	{
		OutError = TEXT("Сейчас нельзя менять покемона");
		return false;
	}
	if (!Game->Team.IsValidIndex(TeamIndex) || Game->Team[TeamIndex].IsFainted())
	{
		OutError = TEXT("Этот покемон не может сражаться");
		return false;
	}
	Events.Reset();
	PlayerActive = TeamIndex;
	FMemory::Memzero(Stages[0]);
	Vol[0] = FLigaVolatile();
	Participants.AddUnique(PlayerMon().Uid);
	Push(ELigaEvent::Switch, ELigaSide::Player).Uid = PlayerMon().Uid;
	Say(FString::Printf(TEXT("Вперёд, %s!"), *LigaRules::DisplayName(PlayerMon())));
	Phase = ELigaBattlePhase::Choose;
	return true;
}

void FLigaBattle::Close()
{
	if (Result == ELigaBattleResult::Lose)
	{
		for (FLigaPokemon& P : Game->Team) LigaRules::HealFully(P);
		return;
	}
	for (int32 Uid : Leveled)
	{
		const FLigaPokemon* P = Game->FindByUid(Uid);
		if (!P || P->HP <= 0) continue;
		const int32 To = LigaRules::LevelEvolution(*P);
		if (To > 0) PendingEvolutions.Add({Uid, To});
	}
}

bool LigaApplyItem(FLigaPokemon& P, const FString& ItemId, FString& OutMessage, int32* OutHealed, bool* OutCured)
{
	const FLigaItem* Item = FLigaDatabase::Get().Item(ItemId);
	const FString Name = LigaRules::DisplayName(P);
	const int32 MHP = LigaRules::MaxHp(P);
	if (!Item)
	{
		OutMessage = TEXT("Неизвестный предмет.");
		return false;
	}
	if (Item->Kind == TEXT("heal"))
	{
		if (P.HP <= 0) { OutMessage = FString::Printf(TEXT("%s без сознания — зелье не поможет."), *Name); return false; }
		if (P.HP >= MHP) { OutMessage = FString::Printf(TEXT("%s: здоровье и так полное."), *Name); return false; }
		const int32 Healed = FMath::Min(MHP - P.HP, Item->Heal < 0 ? MHP : Item->Heal);
		P.HP += Healed;
		if (OutHealed) *OutHealed = Healed;
		OutMessage = FString::Printf(TEXT("%s восстанавливает %d HP."), *Name, Healed);
		return true;
	}
	if (Item->Kind == TEXT("status"))
	{
		if (P.HP <= 0) { OutMessage = FString::Printf(TEXT("%s без сознания."), *Name); return false; }
		if (P.GetStatus() == EStatus::None || (!Item->bCureAll && Item->Cure != P.GetStatus())) { OutMessage = TEXT("Это не подействует."); return false; }
		const FString Was = LigaTypes::StatusName(P.GetStatus());
		P.SetStatus(EStatus::None);
		P.SleepTurns = 0;
		if (OutCured) *OutCured = true;
		OutMessage = FString::Printf(TEXT("%s: статус «%s» снят."), *Name, *Was);
		return true;
	}
	if (Item->Kind == TEXT("revive"))
	{
		if (P.HP > 0) { OutMessage = FString::Printf(TEXT("%s и так в сознании."), *Name); return false; }
		P.HP = FMath::Max(1, (int32)(MHP * Item->Revive));
		P.SetStatus(EStatus::None);
		OutMessage = FString::Printf(TEXT("%s приходит в себя!"), *Name);
		return true;
	}
	if (Item->Kind == TEXT("pp"))
	{
		if (!P.Moves.ContainsByPredicate([](const FLigaMoveSlot& M) { return M.PP < M.MaxPP; })) { OutMessage = TEXT("PP и так полные."); return false; }
		for (FLigaMoveSlot& M : P.Moves) M.PP = FMath::Min(M.MaxPP, M.PP + Item->PP);
		OutMessage = FString::Printf(TEXT("%s: PP атак восстановлены."), *Name);
		return true;
	}
	OutMessage = TEXT("Этот предмет нельзя использовать так.");
	return false;
}
