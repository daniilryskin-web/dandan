// Лига 17 — game flow: exploring, dialogue, choices (starter, moves), battles and the pause menu.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "LigaPlayerController.generated.h"

class ALigaBattleStage;
class ALigaNPC;
struct FLigaQuestDef;

enum class ELigaMode : uint8 { Explore, Dialogue, Choice, Battle, Menu, Fishing };
enum class ELigaBattleMenu : uint8 { None, Main, Fight, Bag, Team, ForceSwitch, Result };

struct FLigaChoice
{
	FString Label;
	FString Detail;
	int32 Species = 0;
	FLinearColor Color = FLinearColor(0.2f, 0.25f, 0.4f);
	bool bEnabled = true;
};

UCLASS()
class LIGA17_API ALigaPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	ALigaPlayerController();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	ELigaMode Mode = ELigaMode::Explore;
	/** Bumped whenever the HUD needs to rebuild a dynamic panel. */
	int32 UiSerial = 0;
	FString CurrentPlaceName() const { return PlaceName; }
	/** "КАНТО" or "ДЖОТО". */
	FString RegionName() const { return Region; }
	bool IsIndoors() const { return bIndoors; }
	bool IsExploring() const { return Mode == ELigaMode::Explore && !bTraveling; }

	// ——— dialogue ———
	FString Speaker;
	TArray<FString> Lines;
	int32 LineIndex = 0;
	void ShowDialogue(const FString& InSpeaker, const TArray<FString>& InLines, TFunction<void()> Then = nullptr);
	void AdvanceDialogue();

	// ——— choices ———
	FString ChoiceTitle;
	TArray<FLigaChoice> Choices;
	bool bChoiceCancelable = false;
	bool bChoicePictures = false;
	void ShowChoice(const FString& Title, const TArray<FLigaChoice>& InChoices, TFunction<void(int32)> OnPick, bool bCancelable = false, bool bPictures = false);
	void PickChoice(int32 Index);

	// ——— story, people and services ———
	void TalkToOak();
	void TalkToMom();
	/** Quests first (reports, new quests, reminders), then what this person does: heal, shop, chat. */
	void TalkToNpc(ALigaNPC* Npc);
	void NurseHeal(const FString& Who);
	void OpenShop(const FString& Who);
	void OpenStorage();
	/** Finishes quests that complete by themselves and announces the ones ready to report. */
	void CheckQuests();

	// ——— trainers, the train, fishing ———
	/** A trainer saw the player (or was spoken to): their words, then the battle. */
	void ChallengeTrainer(ALigaNPC* Npc);
	/** Asks, then takes the train to the other region. */
	void RideTrain(const FString& Title, const FVector& Where, float Yaw);
	/** Casts the rod: after a while something bites, and E must be pressed in time. */
	void StartFishing(const FString& SpotId, const FString& Title);
	bool IsFishBiting() const { return Mode == ELigaMode::Fishing && bFishBite; }

	// ——— doors ———
	/** Fades to black, moves the player (and the walking Pokémon) there, fades back in. */
	void TravelTo(const FVector& Where, float Yaw);
	bool IsTraveling() const { return bTraveling; }
	/** Seconds until walking into a door works again (no bouncing between two doors). */
	float DoorCooldown = 0.f;

	// ——— battle ———
	TWeakObjectPtr<ALigaBattleStage> Stage;
	ELigaBattleMenu BattleMenu = ELigaBattleMenu::None;
	void TryWildEncounter(const FString& Route, const FString& Place = FString());
	void SetBattleMenu(ELigaBattleMenu M);
	void BattleMove(int32 Index);
	void BattleItem(const FString& ItemId);
	void BattleSwitch(int32 TeamIndex);
	void BattleRun();
	void BattleContinue();

	// ——— menu ———
	void ToggleMenu();
	/** Use healing and status items outside battle. */
	void OpenBag();
	/** The pause menu page: 0 the team and quests, 1 the Pokédex. */
	int32 MenuPage = 0;
	int32 DexPage = 0;
	int32 DexSelected = 1;
	void OpenPokedex();
	void TurnDexPage(int32 Delta);
	void SelectDex(int32 Species);
	void CloseMenuPage();
	void SaveFromMenu();
	void QuitGame();

	// ——— input from the character ———
	void OnConfirm();
	void OnBack();
	void OnNumberKey(int32 N);

	// ——— HUD helpers ———
	FString Toast;
	float ToastTime = 0.f;
	void ShowToast(const FString& Text, float Seconds = 3.f);
	/** "E — Поговорить: Профессор Оук" when something interactable is in front of the player. */
	FString CurrentPrompt() const;
	float Fade = 0.f;

private:
	FString PlaceName = TEXT("Паллет-таун");
	FString Region = TEXT("КАНТО");
	/** The trainer being fought (layout NPC id), empty in wild battles. */
	FString TrainerNpcId;
	bool bFishingBattle = false;
	float FishTimer = 0.f;
	bool bFishBite = false;
	FString FishSpot;
	bool bIndoors = false;
	float PlaceCheck = 0.f;
	bool bTraveling = false;
	bool bTravelArrived = false;
	FVector TravelWhere = FVector::ZeroVector;
	float TravelYaw = 0.f;
	TSet<FString> AnnouncedQuests;

	TFunction<void()> AfterDialogue;
	TFunction<void(int32)> OnChoicePicked;
	TArray<TFunction<void()>> PostBattleSteps;
	float PlayTimeTick = 0.f;

	void ApplyInputMode();
	void SetMode(ELigaMode M);
	void RunPostBattle();
	void FinishBattle();
	void RememberPosition();
	void AfterTurn();
	void UpdatePlace(float Dt);
	void UpdateTravel(float Dt);
	void BuyAmount(const FString& Who, const FString& ItemId);
	void StorageList(bool bWithdraw);
	FString NpcName(const FString& Id) const;
	void QuestStarted(const FLigaQuestDef& Q);
	void BeginBattleStage();
	void StartTrainerBattle(const FString& NpcId, const FString& Name);
	/** The rival's counter to the player's first Pokémon. */
	int32 RivalStarter() const;
	void TalkToElm(const FString& Who);
	void UpdateFishing(float Dt);
	void FishingConfirm();
	void StopFishing(const FString& Message);
	void UseItemOn(const FString& ItemId);
};
