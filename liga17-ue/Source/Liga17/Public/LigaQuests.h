// Лига 17 — quests: who gives them, what to do, how progress is counted and what they reward.
#pragma once

#include "CoreMinimal.h"
#include "LigaPokemon.h"

enum class ELigaQuestGoal : uint8
{
	Flag,     // a story flag is set (Counter = flag name)
	Counter,  // an event counter grew by Target since the quest was taken
	DexSeen,  // the Pokédex lists at least Target species
	Talk,     // just talk to the TurnIn NPC
};

struct FLigaQuestDef
{
	FString Id;
	FString Title;
	/** What to do, shown in the tracker and the quest log. */
	FString Goal;
	/** NPC id that offers the quest; empty = started by the story. */
	FString Giver;
	/** NPC id to report to; empty = completes by itself as soon as the goal is reached. */
	FString TurnIn;
	/** Quest that must be finished first. */
	FString Requires;
	bool bNeedsStarter = true;
	ELigaQuestGoal Kind = ELigaQuestGoal::Counter;
	FString Counter;
	int32 Target = 1;
	int32 RewardMoney = 0;
	TArray<TPair<FString, int32>> RewardItems;
	/** Key item handed over with the quest and taken back when it is done. */
	FString KeyItem;
	TArray<FString> Offer;
	/** "{progress}" is replaced with e.g. "3 из 10". */
	TArray<FString> Remind;
	TArray<FString> Done;
};

namespace LigaQuests
{
	LIGA17_API const TArray<FLigaQuestDef>& All();
	LIGA17_API const FLigaQuestDef* Find(const FString& Id);

	/** 0 not taken, 1 active, 2 done. */
	LIGA17_API int32 State(const FLigaGameData& D, const FString& Id);
	LIGA17_API int32 Progress(const FLigaGameData& D, const FLigaQuestDef& Q);
	LIGA17_API bool IsComplete(const FLigaGameData& D, const FLigaQuestDef& Q);
	/** Can be offered right now (not taken, requirements met). */
	LIGA17_API bool IsAvailable(const FLigaGameData& D, const FLigaQuestDef& Q);
	LIGA17_API void Start(FLigaGameData& D, const FLigaQuestDef& Q);
	/** Marks the quest done, gives the reward and returns "Награда: …". */
	LIGA17_API FString Finish(FLigaGameData& D, const FLigaQuestDef& Q);
	/** "3 из 10" for counters, empty for one-step goals. */
	LIGA17_API FString ProgressText(const FLigaGameData& D, const FLigaQuestDef& Q);
	LIGA17_API TArray<FString> WithProgress(const FLigaGameData& D, const FLigaQuestDef& Q, const TArray<FString>& Lines);

	/** Name-tag marker for an NPC: "!" has a quest for you, "?" waits for your report, "…" quest in progress. */
	LIGA17_API FString MarkerFor(const FLigaGameData& D, const FString& NpcId);

	LIGA17_API int32 GetCounter(const FLigaGameData& D, const FString& Name);
	LIGA17_API void AddCounter(FLigaGameData& D, const FString& Name, int32 N = 1);
	/** English type id ("water", "bug") for counters such as "catch_type:water". */
	LIGA17_API FString TypeId(EPokeType T);

	/** Saves from before quests existed: the starter quest counts as done once the player has a Pokémon. */
	LIGA17_API void Upgrade(FLigaGameData& D);
	LIGA17_API int32 NumDone(const FLigaGameData& D);
}
