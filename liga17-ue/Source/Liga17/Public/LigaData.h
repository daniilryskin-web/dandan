// Лига 17 — static game data loaded from Content/Liga/Data/*.json (generated from PokeAPI by liga3d/scripts/build-data.mjs).
#pragma once

#include "CoreMinimal.h"
#include "LigaTypes.h"

struct FLigaEvolution
{
	int32 To = 0;
	int32 Level = 0;          // 0 = not a level evolution
	FString Item;             // evolution stone etc.
	FString Time;             // "day" / "night"
};

struct FLigaSpecies
{
	int32 Id = 0;
	FString Name;
	FString En;
	TArray<EPokeType> Types;
	int32 Base[ST_Count] = {};
	int32 CatchRate = 45;
	int32 BaseExp = 64;
	FString Growth = TEXT("mediumFast");
	float MaleRatio = 0.5f;   // < 0: genderless
	int32 Stage = 1;
	TArray<FLigaEvolution> Evolutions;
	TArray<TPair<int32, FString>> Learnset; // (level, move id), sorted by level
	float Height = 1.f;
	int32 Gen = 1;
	bool bLegendary = false;
	bool bMythical = false;
};

struct FLigaMoveEffect
{
	EStatus Status = EStatus::None;
	int32 StatusChance = 0;
	int32 ConfuseChance = 0;
	bool bStatsSelf = false;
	bool bHasStats = false;
	int32 StatChanges[BS_Count] = {};
	int32 StatsChance = 100;
	int32 Flinch = 0;
	float Drain = 0.f;
	float Recoil = 0.f;
	float Heal = 0.f;
	int32 MultiHitMin = 0;
	int32 MultiHitMax = 0;
	/** -1: none, -2: user's level, -3: half of the target's HP, otherwise fixed damage. */
	int32 FixedDamage = -1;
	bool bHighCrit = false;
	bool bRest = false;
	bool bFlee = false;
	bool bPayDay = false;
	bool bHex = false;
	bool bProtect = false;
	bool bRecharge = false;
	bool bSelfKO = false;
	bool bOHKO = false;
};

struct FLigaMove
{
	FString Id;
	FString Name;
	EPokeType Type = EPokeType::Normal;
	EMoveCategory Category = EMoveCategory::Physical;
	int32 Power = 0;
	int32 Accuracy = 100; // -1: never misses
	int32 PP = 10;
	int32 Priority = 0;
	FLigaMoveEffect Effect;
};

struct FLigaItem
{
	FString Id;
	FString Name;
	FString Kind; // ball / heal / status / revive / pp / key
	int32 Price = 0;
	float Ball = 0.f;
	int32 Heal = 0;   // HP restored; -1 = full
	EStatus Cure = EStatus::None;
	bool bCureAll = false;
	float Revive = 0.f;
	int32 PP = 0;
	FString Desc;
};

/** A wild encounter slot of a route. */
struct FLigaEncounter
{
	int32 Species = 0;
	int32 MinLevel = 2;
	int32 MaxLevel = 4;
	int32 Weight = 10;
};

class LIGA17_API FLigaDatabase
{
public:
	static FLigaDatabase& Get();

	bool IsLoaded() const { return bLoaded; }
	/** Loads species, moves and items; returns false (and logs) if a file is missing. */
	bool Load();

	const FLigaSpecies* Species(int32 Id) const;
	const FLigaMove* Move(const FString& Id) const;
	const FLigaItem* Item(const FString& Id) const;
	int32 NumSpecies() const { return SpeciesList.Num(); }
	const TArray<FLigaItem>& Items() const { return ItemList; }
	const TArray<FLigaEncounter>* Encounters(const FString& Route) const { return EncounterTables.Find(Route); }

	static FString DataDir();

private:
	bool bLoaded = false;
	TArray<FLigaSpecies> SpeciesList;          // index = id - 1
	TMap<FString, FLigaMove> Moves;
	TArray<FLigaItem> ItemList;
	TMap<FString, TArray<FLigaEncounter>> EncounterTables;

	bool LoadSpecies(const FString& Path);
	/** Puts back the Kanto and Johto evolutions where the data lists a regional form's instead (Alolan Sandshrew…). */
	void FixClassicEvolutions();
	bool LoadMoves(const FString& Path);
	void BuildItems();
	void BuildEncounters();
};
