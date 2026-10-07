#include "LigaPokemon.h"

#include "LigaData.h"

int32 FLigaGameData::FirstAliveIndex() const
{
	for (int32 i = 0; i < Team.Num(); ++i)
	{
		if (!Team[i].IsFainted()) return i;
	}
	return INDEX_NONE;
}

FLigaPokemon* FLigaGameData::FindByUid(int32 Uid)
{
	for (FLigaPokemon& P : Team)
	{
		if (P.Uid == Uid) return &P;
	}
	return nullptr;
}

namespace LigaRules
{
	const FLigaSpecies* SpeciesOf(const FLigaPokemon& P)
	{
		return FLigaDatabase::Get().Species(P.Species);
	}

	TArray<EPokeType> TypesOf(const FLigaPokemon& P)
	{
		const FLigaSpecies* S = SpeciesOf(P);
		return S ? S->Types : TArray<EPokeType>{EPokeType::Normal};
	}

	int32 ExpForLevel(const FString& Growth, int32 Level)
	{
		if (Level <= 1) return 0;
		const double N = Level;
		const double N3 = N * N * N;
		if (Growth == TEXT("fast")) return (int32)FMath::FloorToDouble(4.0 * N3 / 5.0);
		if (Growth == TEXT("mediumSlow")) return FMath::Max(0, (int32)FMath::FloorToDouble(1.2 * N3 - 15.0 * N * N + 100.0 * N - 140.0));
		if (Growth == TEXT("slow")) return (int32)FMath::FloorToDouble(5.0 * N3 / 4.0);
		if (Growth == TEXT("erratic"))
		{
			if (Level <= 50) return (int32)FMath::FloorToDouble(N3 * (100.0 - N) / 50.0);
			if (Level <= 68) return (int32)FMath::FloorToDouble(N3 * (150.0 - N) / 100.0);
			if (Level <= 98) return (int32)FMath::FloorToDouble(N3 * FMath::FloorToDouble((1911.0 - 10.0 * N) / 3.0) / 500.0);
			return (int32)FMath::FloorToDouble(N3 * (160.0 - N) / 100.0);
		}
		if (Growth == TEXT("fluctuating"))
		{
			if (Level <= 15) return (int32)FMath::FloorToDouble(N3 * (FMath::FloorToDouble((N + 1.0) / 3.0) + 24.0) / 50.0);
			if (Level <= 36) return (int32)FMath::FloorToDouble(N3 * (N + 14.0) / 50.0);
			return (int32)FMath::FloorToDouble(N3 * (FMath::FloorToDouble(N / 2.0) + 32.0) / 50.0);
		}
		return (int32)N3; // mediumFast
	}

	int32 CalcStat(const FLigaPokemon& P, int32 Stat)
	{
		const FLigaSpecies* S = SpeciesOf(P);
		if (!S) return 1;
		const int32 IV = P.IVs.IsValidIndex(Stat) ? P.IVs[Stat] : 0;
		const int32 EV = P.EVs.IsValidIndex(Stat) ? P.EVs[Stat] : 0;
		const int32 Core = ((2 * S->Base[Stat] + IV + EV / 4) * P.Level) / 100;
		if (Stat == ST_HP) return Core + P.Level + 10;
		return (int32)FMath::FloorToFloat((Core + 5) * LigaTypes::NatureMultiplier(P.Nature, Stat));
	}

	FLigaStats CalcStats(const FLigaPokemon& P)
	{
		FLigaStats Out;
		for (int32 i = 0; i < ST_Count; ++i) Out.V[i] = CalcStat(P, i);
		return Out;
	}

	int32 MaxHp(const FLigaPokemon& P) { return CalcStat(P, ST_HP); }

	FString DisplayName(const FLigaPokemon& P)
	{
		if (!P.Nickname.IsEmpty()) return P.Nickname;
		const FLigaSpecies* S = SpeciesOf(P);
		return S ? S->Name : TEXT("???");
	}

	FLigaMoveSlot MakeSlot(const FString& MoveId)
	{
		FLigaMoveSlot Slot;
		Slot.Id = MoveId;
		const FLigaMove* M = FLigaDatabase::Get().Move(MoveId);
		Slot.PP = Slot.MaxPP = M ? M->PP : 10;
		return Slot;
	}

	TArray<FLigaMoveSlot> DefaultMoves(int32 Species, int32 Level)
	{
		TArray<FString> Ids;
		if (const FLigaSpecies* S = FLigaDatabase::Get().Species(Species))
		{
			for (const TPair<int32, FString>& L : S->Learnset)
			{
				if (L.Key > Level) continue;
				if (!FLigaDatabase::Get().Move(L.Value)) continue; // not implemented in the move table
				Ids.Remove(L.Value);
				Ids.Add(L.Value);
			}
		}
		if (Ids.Num() == 0) Ids.Add(TEXT("tackle"));
		TArray<FLigaMoveSlot> Out;
		for (int32 i = FMath::Max(0, Ids.Num() - 4); i < Ids.Num(); ++i) Out.Add(MakeSlot(Ids[i]));
		return Out;
	}

	FLigaPokemon CreatePokemon(int32 Species, int32 Level, FRandomStream& Rng, int32 Uid, int32 ForceShiny)
	{
		const FLigaSpecies* S = FLigaDatabase::Get().Species(Species);
		FLigaPokemon P;
		P.Uid = Uid;
		P.Species = Species;
		P.Level = FMath::Clamp(Level, 1, MaxLevel);
		P.Exp = ExpForLevel(S ? S->Growth : TEXT("mediumFast"), P.Level);
		const TArray<LigaTypes::FNature>& Natures = LigaTypes::Natures();
		P.Nature = Natures[Rng.RandRange(0, Natures.Num() - 1)].Id;
		P.IVs.SetNum(ST_Count);
		P.EVs.Init(0, ST_Count);
		for (int32 i = 0; i < ST_Count; ++i) P.IVs[i] = Rng.RandRange(0, 31);
		if (!S || S->MaleRatio < 0.f) P.Gender = 0;
		else P.Gender = Rng.FRand() < S->MaleRatio ? 1 : 2;
		P.bShiny = ForceShiny >= 0 ? ForceShiny != 0 : Rng.FRand() < ShinyChance;
		P.Moves = DefaultMoves(Species, P.Level);
		P.Ball = TEXT("poke-ball");
		P.MetLevel = P.Level;
		P.HP = MaxHp(P);
		return P;
	}

	void HealFully(FLigaPokemon& P)
	{
		P.HP = MaxHp(P);
		P.SetStatus(EStatus::None);
		P.SleepTurns = 0;
		for (FLigaMoveSlot& M : P.Moves) M.PP = M.MaxPP;
	}

	float ExpRatio(const FLigaPokemon& P)
	{
		const FLigaSpecies* S = SpeciesOf(P);
		if (!S || P.Level >= MaxLevel) return 1.f;
		const int32 Lo = ExpForLevel(S->Growth, P.Level);
		const int32 Hi = ExpForLevel(S->Growth, P.Level + 1);
		return Hi > Lo ? FMath::Clamp(float(P.Exp - Lo) / float(Hi - Lo), 0.f, 1.f) : 1.f;
	}

	TArray<FString> MovesLearnedAt(int32 Species, int32 Level)
	{
		TArray<FString> Out;
		if (const FLigaSpecies* S = FLigaDatabase::Get().Species(Species))
		{
			for (const TPair<int32, FString>& L : S->Learnset)
			{
				if (L.Key == Level && FLigaDatabase::Get().Move(L.Value)) Out.AddUnique(L.Value);
			}
		}
		return Out;
	}

	FLigaLevelUpResult GainExp(FLigaPokemon& P, int32 Amount)
	{
		FLigaLevelUpResult Res;
		const FLigaSpecies* S = SpeciesOf(P);
		if (!S || P.Level >= MaxLevel) return Res;
		P.Exp = FMath::Min(P.Exp + Amount, ExpForLevel(S->Growth, MaxLevel));
		while (P.Level < MaxLevel && P.Exp >= ExpForLevel(S->Growth, P.Level + 1))
		{
			const int32 OldMax = MaxHp(P);
			P.Level += 1;
			if (P.HP > 0) P.HP += MaxHp(P) - OldMax;
			Res.Levels.Add(P.Level);
			for (const FString& Mv : MovesLearnedAt(P.Species, P.Level))
			{
				if (P.Moves.ContainsByPredicate([&Mv](const FLigaMoveSlot& M) { return M.Id == Mv; })) continue;
				if (P.Moves.Num() < 4)
				{
					P.Moves.Add(MakeSlot(Mv));
					Res.Learned.Add(Mv);
				}
				else
				{
					Res.Pending.Add(Mv);
				}
			}
		}
		return Res;
	}

	void AddEvYield(FLigaPokemon& P, int32 DefeatedSpecies)
	{
		const FLigaSpecies* S = FLigaDatabase::Get().Species(DefeatedSpecies);
		if (!S) return;
		int32 Best = ST_HP;
		for (int32 i = 0; i < ST_Count; ++i)
		{
			if (S->Base[i] > S->Base[Best]) Best = i;
		}
		if (P.EVs.Num() != ST_Count) P.EVs.Init(0, ST_Count);
		int32 Total = 0;
		for (int32 V : P.EVs) Total += V;
		const int32 Room = FMath::Min(252 - P.EVs[Best], 510 - Total);
		if (Room <= 0) return;
		const int32 OldMax = MaxHp(P);
		P.EVs[Best] += FMath::Min(S->Stage, Room);
		if (Best == ST_HP && P.HP > 0) P.HP += MaxHp(P) - OldMax;
	}

	int32 LevelEvolution(const FLigaPokemon& P)
	{
		const FLigaSpecies* S = SpeciesOf(P);
		if (!S) return 0;
		for (const FLigaEvolution& E : S->Evolutions)
		{
			if (E.Level > 0 && E.Item.IsEmpty() && P.Level >= E.Level && FLigaDatabase::Get().Species(E.To)) return E.To;
		}
		return 0;
	}

	EEvoMethod MethodOf(const FLigaEvolution& E)
	{
		if (E.Item.IsEmpty()) return E.Level > 0 ? EEvoMethod::Level : EEvoMethod::Other;
		if (E.Item == TEXT("soothe-bell")) return EEvoMethod::Friendship;
		if (E.Item == TEXT("linking-cord")) return EEvoMethod::Trade;
		const FLigaItem* It = FLigaDatabase::Get().Item(E.Item);
		return It && It->Kind == TEXT("trade") ? EEvoMethod::TradeItem : EEvoMethod::Item;
	}

	int32 ItemEvolution(const FLigaPokemon& P, const FString& ItemId)
	{
		const FLigaSpecies* S = SpeciesOf(P);
		if (!S || ItemId.IsEmpty()) return 0;
		for (const FLigaEvolution& E : S->Evolutions)
		{
			if (E.Item == ItemId && MethodOf(E) == EEvoMethod::Item && FLigaDatabase::Get().Species(E.To)) return E.To;
		}
		return 0;
	}

	int32 TradeEvolution(const FLigaPokemon& P, FString& OutItem)
	{
		OutItem.Reset();
		const FLigaSpecies* S = SpeciesOf(P);
		if (!S) return 0;
		for (const FLigaEvolution& E : S->Evolutions)
		{
			const EEvoMethod M = MethodOf(E);
			if ((M != EEvoMethod::Trade && M != EEvoMethod::TradeItem) || !FLigaDatabase::Get().Species(E.To)) continue;
			if (M == EEvoMethod::TradeItem) OutItem = E.Item;
			return E.To;
		}
		return 0;
	}

	bool IsDaytime()
	{
		const int32 Hour = FDateTime::Now().GetHour();
		return Hour >= 6 && Hour < 18;
	}

	int32 FriendshipEvolution(const FLigaPokemon& P)
	{
		const FLigaSpecies* S = SpeciesOf(P);
		if (!S || P.Friendship < FriendshipToEvolve) return 0;
		const bool bDay = IsDaytime();
		for (const FLigaEvolution& E : S->Evolutions)
		{
			if (MethodOf(E) != EEvoMethod::Friendship || !FLigaDatabase::Get().Species(E.To)) continue;
			if ((E.Time == TEXT("day") && !bDay) || (E.Time == TEXT("night") && bDay)) continue;
			return E.To;
		}
		return 0;
	}

	FString EvolutionMethodText(const FLigaEvolution& E)
	{
		const FLigaItem* It = FLigaDatabase::Get().Item(E.Item);
		const FString ItemName = It ? It->Name : E.Item;
		switch (MethodOf(E))
		{
		case EEvoMethod::Level: return FString::Printf(TEXT("ур. %d"), E.Level);
		case EEvoMethod::Item: return ItemName;
		case EEvoMethod::Trade: return TEXT("обмен");
		case EEvoMethod::TradeItem: return FString::Printf(TEXT("обмен с предметом «%s»"), *ItemName);
		case EEvoMethod::Friendship:
			return E.Time == TEXT("day") ? TEXT("дружба, днём") : E.Time == TEXT("night") ? TEXT("дружба, ночью") : TEXT("дружба");
		default: return TEXT("особым способом");
		}
	}

	void AddFriendship(FLigaPokemon& P, int32 N)
	{
		P.Friendship = FMath::Clamp(P.Friendship + N, 0, 255);
	}

	FString FriendshipText(const FLigaPokemon& P)
	{
		if (P.Friendship >= FriendshipToEvolve) return TEXT("обожает вас");
		if (P.Friendship >= 150) return TEXT("очень любит вас");
		if (P.Friendship >= 100) return TEXT("дружелюбен к вам");
		if (P.Friendship >= 70) return TEXT("привыкает к вам");
		return TEXT("держится настороженно");
	}

	void Evolve(FLigaPokemon& P, int32 To)
	{
		const float Ratio = P.HP > 0 ? float(P.HP) / float(FMath::Max(1, MaxHp(P))) : 0.f;
		P.Species = To;
		P.HP = P.HP > 0 ? FMath::Max(1, FMath::RoundToInt(MaxHp(P) * Ratio)) : 0;
	}

	void LearnMove(FLigaPokemon& P, const FString& MoveId, int32 ReplaceIndex)
	{
		if (P.Moves.Num() < 4) P.Moves.Add(MakeSlot(MoveId));
		else if (P.Moves.IsValidIndex(ReplaceIndex)) P.Moves[ReplaceIndex] = MakeSlot(MoveId);
	}
}
