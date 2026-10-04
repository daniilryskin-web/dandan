// Лига 17 — game flow: exploring, dialogue, choices (starter, moves), battles and the pause menu.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "LigaPlayerController.generated.h"

class ALigaBattleStage;

enum class ELigaMode : uint8 { Explore, Dialogue, Choice, Battle, Menu };
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
	FString CurrentPlaceName() const;
	bool IsExploring() const { return Mode == ELigaMode::Explore; }

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

	// ——— story ———
	void TalkToOak();
	void TalkToMom();

	// ——— battle ———
	TWeakObjectPtr<ALigaBattleStage> Stage;
	ELigaBattleMenu BattleMenu = ELigaBattleMenu::None;
	void TryWildEncounter(const FString& Route);
	void SetBattleMenu(ELigaBattleMenu M);
	void BattleMove(int32 Index);
	void BattleItem(const FString& ItemId);
	void BattleSwitch(int32 TeamIndex);
	void BattleRun();
	void BattleContinue();

	// ——— menu ———
	void ToggleMenu();
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
};
