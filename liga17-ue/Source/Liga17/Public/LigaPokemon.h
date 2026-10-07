// Лига 17 — persistent player data (team, bag, Pokédex) and the rules that operate on it.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/SaveGame.h"
#include "LigaTypes.h"
#include "LigaPokemon.generated.h"

struct FLigaSpecies;
struct FLigaEvolution;

USTRUCT(BlueprintType)
struct FLigaMoveSlot
{
	GENERATED_BODY()

	UPROPERTY() FString Id;
	UPROPERTY() int32 PP = 0;
	UPROPERTY() int32 MaxPP = 0;
};

USTRUCT(BlueprintType)
struct FLigaPokemon
{
	GENERATED_BODY()

	UPROPERTY() int32 Uid = 0;
	UPROPERTY() int32 Species = 0;
	UPROPERTY() FString Nickname;
	UPROPERTY() int32 Level = 1;
	UPROPERTY() int32 Exp = 0;
	UPROPERTY() FString Nature;
	/** "Гены": individual values 0..31 for HP, Atk, Def, SpA, SpD, Spe. */
	UPROPERTY() TArray<int32> IVs;
	/** "Раскачка": effort values, max 252 each and 510 in total. */
	UPROPERTY() TArray<int32> EVs;
	/** 0 = genderless, 1 = male, 2 = female. */
	UPROPERTY() uint8 Gender = 0;
	UPROPERTY() bool bShiny = false;
	UPROPERTY() int32 HP = 1;
	/** EStatus. */
	UPROPERTY() uint8 Status = 0;
	UPROPERTY() int32 SleepTurns = 0;
	UPROPERTY() TArray<FLigaMoveSlot> Moves;
	UPROPERTY() FString Ball;
	/** 0..255: grows with level-ups, walks together, petting and the Soothe Bell; 220+ lets some species evolve. */
	UPROPERTY() int32 Friendship = 70;
	UPROPERTY() FString MetAt;
	UPROPERTY() int32 MetLevel = 1;

	EStatus GetStatus() const { return (EStatus)Status; }
	void SetStatus(EStatus S) { Status = (uint8)S; }
	bool IsFainted() const { return HP <= 0; }
};

USTRUCT(BlueprintType)
struct FLigaGameData
{
	GENERATED_BODY()

	UPROPERTY() FString PlayerName = TEXT("Ред");
	UPROPERTY() int32 Money = 3000;
	UPROPERTY() TArray<FLigaPokemon> Team;
	UPROPERTY() TArray<FLigaPokemon> Storage;
	UPROPERTY() TMap<FString, int32> Bag;
	/** Species id -> 1 seen, 2 caught. */
	UPROPERTY() TMap<int32, uint8> Dex;
	/** Story flags, e.g. "got_starter". */
	UPROPERTY() TArray<FString> Flags;
	UPROPERTY() int32 NextUid = 1;
	UPROPERTY() bool bHasPosition = false;
	UPROPERTY() FVector PlayerLocation = FVector::ZeroVector;
	UPROPERTY() float PlayerYaw = 0.f;
	UPROPERTY() int32 Encounters = 0;
	UPROPERTY() int32 Caught = 0;
	UPROPERTY() int32 WildDefeated = 0;
	UPROPERTY() double PlaySeconds = 0.0;
	/** Event counters for quests ("heal_center", "buy:poke-ball", "catch_type:water"...). */
	UPROPERTY() TMap<FString, int32> Counters;
	/** Quest id -> 1 active, 2 done. */
	UPROPERTY() TMap<FString, int32> QuestStage;
	/** Quest id -> the counter value when the quest was taken (progress counts from there). */
	UPROPERTY() TMap<FString, int32> QuestBase;

	bool HasFlag(const FString& F) const { return Flags.Contains(F); }
	void SetFlag(const FString& F) { Flags.AddUnique(F); }
	int32 ItemCount(const FString& Id) const { const int32* N = Bag.Find(Id); return N ? *N : 0; }
	void AddItem(const FString& Id, int32 N) { Bag.FindOrAdd(Id) += N; }
	void MarkSeen(int32 Species) { uint8& D = Dex.FindOrAdd(Species); D = FMath::Max<uint8>(D, 1); }
	void MarkCaught(int32 Species) { Dex.FindOrAdd(Species) = 2; }
	int32 FirstAliveIndex() const;
	FLigaPokemon* FindByUid(int32 Uid);
};

UCLASS()
class LIGA17_API ULigaSaveGame : public USaveGame
{
	GENERATED_BODY()

public:
	UPROPERTY() int32 Version = 1;
	UPROPERTY() FLigaGameData Data;
};

struct FLigaStats
{
	int32 V[ST_Count] = {};
	int32 operator[](int32 I) const { return V[I]; }
};

struct FLigaLevelUpResult
{
	TArray<int32> Levels;
	TArray<FString> Learned;
	TArray<FString> Pending;
};

namespace LigaRules
{
	constexpr int32 MaxLevel = 100;
	constexpr int32 MaxTeam = 6;
	constexpr float ShinyChance = 1.f / 512.f;

	LIGA17_API int32 ExpForLevel(const FString& Growth, int32 Level);
	LIGA17_API int32 CalcStat(const FLigaPokemon& P, int32 Stat);
	LIGA17_API FLigaStats CalcStats(const FLigaPokemon& P);
	LIGA17_API int32 MaxHp(const FLigaPokemon& P);
	LIGA17_API FString DisplayName(const FLigaPokemon& P);
	LIGA17_API FLigaMoveSlot MakeSlot(const FString& MoveId);
	LIGA17_API TArray<FLigaMoveSlot> DefaultMoves(int32 Species, int32 Level);
	LIGA17_API FLigaPokemon CreatePokemon(int32 Species, int32 Level, FRandomStream& Rng, int32 Uid, int32 ForceShiny = -1);
	LIGA17_API void HealFully(FLigaPokemon& P);
	LIGA17_API float ExpRatio(const FLigaPokemon& P);
	LIGA17_API FLigaLevelUpResult GainExp(FLigaPokemon& P, int32 Amount);
	LIGA17_API TArray<FString> MovesLearnedAt(int32 Species, int32 Level);
	LIGA17_API void AddEvYield(FLigaPokemon& P, int32 DefeatedSpecies);
	/** Species the Pokémon evolves into at its current level (0 if none). */
	LIGA17_API int32 LevelEvolution(const FLigaPokemon& P);

	/** How an evolution happens: by level, by using an item (stones), by a trade (with a held item or without),
	 *  or by friendship (the data marks those with "soothe-bell"). */
	enum class EEvoMethod : uint8 { Level, Item, Trade, TradeItem, Friendship, Other };
	constexpr int32 FriendshipToEvolve = 220;
	LIGA17_API EEvoMethod MethodOf(const FLigaEvolution& E);
	/** Species this Pokémon becomes when the item (a stone…) is used on it, 0 if it does not react. */
	LIGA17_API int32 ItemEvolution(const FLigaPokemon& P, const FString& ItemId);
	/** Species it becomes when traded (OutItem: the item it must hold, empty if none), 0 if it does not evolve by trade. */
	LIGA17_API int32 TradeEvolution(const FLigaPokemon& P, FString& OutItem);
	/** Species it becomes on a level-up thanks to its friendship (and the time of day, if that matters), 0 if none. */
	LIGA17_API int32 FriendshipEvolution(const FLigaPokemon& P);
	/** "ур. 16", "Огненный камень", "обмен", "дружба, днём"… for the Pokédex. */
	LIGA17_API FString EvolutionMethodText(const FLigaEvolution& E);
	LIGA17_API void AddFriendship(FLigaPokemon& P, int32 N);
	/** "обожает вас", "очень любит вас"… */
	LIGA17_API FString FriendshipText(const FLigaPokemon& P);
	/** Day (06:00–18:00 on this computer's clock) or night: Eevee becomes Espeon by day and Umbreon by night. */
	LIGA17_API bool IsDaytime();
	LIGA17_API void Evolve(FLigaPokemon& P, int32 To);
	/** Teaches a move, replacing slot ReplaceIndex (or appending when < 4 moves). */
	LIGA17_API void LearnMove(FLigaPokemon& P, const FString& MoveId, int32 ReplaceIndex);
	LIGA17_API const FLigaSpecies* SpeciesOf(const FLigaPokemon& P);
	LIGA17_API TArray<EPokeType> TypesOf(const FLigaPokemon& P);
}
