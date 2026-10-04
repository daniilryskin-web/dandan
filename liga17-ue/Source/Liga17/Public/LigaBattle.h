// Лига 17 — turn-based battle engine (port of liga3d/src/engine/battle.ts).
#pragma once

#include "CoreMinimal.h"
#include "LigaPokemon.h"

struct FLigaMove;

enum class ELigaSide : uint8 { Player = 0, Enemy = 1 };
enum class ELigaBattleResult : uint8 { None, Win, Lose, Caught, Fled };
enum class ELigaBattlePhase : uint8 { Choose, ForceSwitch, Ended };

enum class ELigaEvent : uint8
{
	Msg, Move, Damage, Heal, Status, Confuse, Protect, Stat, Miss, Faint, Switch, Ball, Exp, LevelUp, Learn, End
};

struct FLigaBattleEvent
{
	ELigaEvent T = ELigaEvent::Msg;
	ELigaSide Side = ELigaSide::Player;
	FString Text;
	FString MoveId;
	int32 Amount = 0;
	int32 Hp = 0;
	float Eff = 1.f;
	bool bCrit = false;
	EStatus Status = EStatus::None;
	int32 Stat = 0;
	int32 Delta = 0;
	int32 Uid = 0;
	int32 Level = 0;
	FString Ball;
	int32 Shakes = 0;
	bool bCaught = false;
	ELigaBattleResult Result = ELigaBattleResult::None;
};

struct FLigaBattleAction
{
	enum EKind : uint8 { Move, Switch, Item, Run };
	EKind Kind = Move;
	int32 Index = 0;
	FString ItemId;
	int32 TargetUid = 0;

	static FLigaBattleAction MakeMove(int32 I) { FLigaBattleAction A; A.Kind = Move; A.Index = I; return A; }
	static FLigaBattleAction MakeSwitch(int32 I) { FLigaBattleAction A; A.Kind = Switch; A.Index = I; return A; }
	static FLigaBattleAction MakeItem(const FString& Id, int32 Target = 0) { FLigaBattleAction A; A.Kind = Item; A.ItemId = Id; A.TargetUid = Target; return A; }
	static FLigaBattleAction MakeRun() { FLigaBattleAction A; A.Kind = Run; return A; }
};

struct FLigaVolatile
{
	int32 Confused = 0;
	bool bRecharge = false;
	int32 ProtectStreak = 0;
	bool bProtected = false;
};

struct FLigaPendingLearn
{
	int32 Uid = 0;
	FString MoveId;
};

struct FLigaPendingEvolution
{
	int32 Uid = 0;
	int32 To = 0;
};

class LIGA17_API FLigaBattle
{
public:
	/** Starts a wild battle; the intro messages are in Events. Returns null if the player has no healthy Pokémon. */
	static TUniquePtr<FLigaBattle> StartWild(FLigaGameData& Game, int32 Species, int32 Level, const FString& Place, int32 Seed);

	/** Runs one turn. Returns false with OutError if the action is not allowed (nothing happens then). */
	bool DoTurn(const FLigaBattleAction& Action, FString& OutError);
	/** After the active Pokémon fainted: sends in another one. */
	bool ForceSwitch(int32 TeamIndex, FString& OutError);
	/** Finishes the battle: heals on defeat and collects evolutions. Call once after Phase == Ended. */
	void Close();

	FLigaPokemon& PlayerMon() const { return Game->Team[PlayerActive]; }
	FLigaPokemon& EnemyMon() { return EnemyTeam[EnemyActive]; }
	FLigaPokemon& Mon(ELigaSide Side) { return Side == ELigaSide::Player ? Game->Team[PlayerActive] : EnemyTeam[EnemyActive]; }

	FLigaGameData* Game = nullptr;
	bool bWild = true;
	FString TrainerName;
	FString Place;
	TArray<FLigaPokemon> EnemyTeam;
	int32 EnemyActive = 0;
	int32 PlayerActive = 0;
	int32 Stages[2][BS_Count] = {};
	FLigaVolatile Vol[2];
	TArray<int32> Participants;
	TArray<int32> Leveled;
	int32 Turn = 0;
	int32 RunAttempts = 0;
	int32 PayDay = 0;
	ELigaBattlePhase Phase = ELigaBattlePhase::Choose;
	ELigaBattleResult Result = ELigaBattleResult::None;
	/** Events produced by the latest Start/DoTurn/ForceSwitch, for the presentation layer. */
	TArray<FLigaBattleEvent> Events;
	TArray<FLigaPendingLearn> PendingLearn;
	TArray<FLigaPendingEvolution> PendingEvolutions;
	FRandomStream Rng;

	static float StageMult(int32 Stage);
	static float AccMult(int32 Stage);
	static int32 CatchShakes(const FLigaPokemon& Target, float BallMult, FRandomStream& Rng);
	static int32 ComputeDamage(const FLigaPokemon& Attacker, const FLigaPokemon& Defender, const FLigaMove& Move, const int32* AtkStages,
		const int32* DefStages, bool bCrit, float Roll, float& OutEff);

private:
	bool Flinch[2] = {false, false};

	static int32 Idx(ELigaSide S) { return (int32)S; }
	static ELigaSide Other(ELigaSide S) { return S == ELigaSide::Player ? ELigaSide::Enemy : ELigaSide::Player; }
	FString Label(ELigaSide Side);
	void Say(const FString& Text);
	FLigaBattleEvent& Push(ELigaEvent T, ELigaSide Side);
	float EffectiveSpeed(ELigaSide Side);
	bool StatusImmune(const FLigaPokemon& P, EStatus S) const;
	bool InflictStatus(ELigaSide Side, EStatus S, bool bFromStatusMove);
	void ChangeStages(ELigaSide Side, const int32* Changes);
	int32 ApplyDamage(ELigaSide Side, int32 Amount, float Eff, bool bCrit);
	int32 ApplyHeal(ELigaSide Side, int32 Amount);
	void Confuse(ELigaSide Side, bool bFromStatusMove);
	void SelfKnockOut(ELigaSide Side);
	/** SlotIndex < 0 means Struggle. */
	void UseMove(ELigaSide Side, int32 SlotIndex, bool bMovedFirst);
	void RunStatusMove(ELigaSide Side, const FLigaMove& Move);
	int32 ChooseEnemyMove();
	bool TryRun();
	void SwitchPlayer(int32 Index);
	void UseBattleItem(const FString& ItemId, int32 TargetUid);
	bool ThrowBall(const FString& BallId);
	void EndOfTurn();
	void ResolveFaints();
	void AwardExp(const FLigaPokemon& Defeated);
	void Finish(ELigaBattleResult R);
	int32 MultiHitCount(int32 Lo, int32 Hi);
	bool Chance(int32 Percent) { return Percent >= 100 || Rng.FRand() * 100.f < Percent; }
};

/** Applies a healing/status/revive/PP item outside of battle too. Does not consume it. */
LIGA17_API bool LigaApplyItem(FLigaPokemon& P, const FString& ItemId, FString& OutMessage, int32* OutHealed = nullptr, bool* OutCured = nullptr);
