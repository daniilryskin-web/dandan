// Лига 17 — basic Pokémon rules data: types, type chart, natures, stats.
#pragma once

#include "CoreMinimal.h"

enum class EPokeType : uint8
{
	Normal, Fire, Water, Electric, Grass, Ice, Fighting, Poison, Ground,
	Flying, Psychic, Bug, Rock, Ghost, Dragon, Dark, Steel, Fairy,
	Count
};

enum class EMoveCategory : uint8 { Physical, Special, Status };

/** Stat indices: HP, Attack, Defense, Sp. Attack, Sp. Defense, Speed. */
enum EStat : int32 { ST_HP = 0, ST_Atk, ST_Def, ST_SpA, ST_SpD, ST_Spe, ST_Count };

/** Battle-only stat stages (no HP, plus accuracy and evasion). */
enum EBattleStat : int32 { BS_Atk = 0, BS_Def, BS_SpA, BS_SpD, BS_Spe, BS_Acc, BS_Eva, BS_Count };

/** Major status conditions. */
enum class EStatus : uint8 { None, Burn, Poison, Paralysis, Sleep, Freeze };

namespace LigaTypes
{
	LIGA17_API EPokeType Parse(const FString& Id);
	LIGA17_API FString Name(EPokeType T);
	LIGA17_API FLinearColor Color(EPokeType T);
	LIGA17_API float Multiplier(EPokeType Attack, EPokeType Defend);
	LIGA17_API float Effectiveness(EPokeType Attack, const TArray<EPokeType>& Defenders);
	/** "Эффективно ×2" etc., empty for neutral. */
	LIGA17_API FString EffectivenessLabel(float Mult);

	LIGA17_API EStatus ParseStatus(const FString& Id);
	LIGA17_API FString StatusName(EStatus S);
	LIGA17_API FString StatusShort(EStatus S);
	LIGA17_API FLinearColor StatusColor(EStatus S);

	LIGA17_API int32 ParseBattleStat(const FString& Id);
	LIGA17_API FString BattleStatName(int32 Stat);
	LIGA17_API FString StatName(int32 Stat);

	struct FNature
	{
		const TCHAR* Id;
		const TCHAR* Name;
		int32 Up;   // EStat or -1
		int32 Down; // EStat or -1
	};
	LIGA17_API const TArray<FNature>& Natures();
	LIGA17_API const FNature* FindNature(const FString& Id);
	LIGA17_API float NatureMultiplier(const FString& NatureId, int32 Stat);
}
