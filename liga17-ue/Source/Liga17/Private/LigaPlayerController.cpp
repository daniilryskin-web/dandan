#include "LigaPlayerController.h"

#include "GameFramework/Character.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "Kismet/GameplayStatics.h"
#include "Kismet/KismetSystemLibrary.h"
#include "LigaBattleStage.h"
#include "LigaCharacter.h"
#include "LigaData.h"
#include "LigaGameInstance.h"
#include "LigaInteractable.h"
#include "LigaWorldBuilder.h"
#include "EngineUtils.h"

ALigaPlayerController::ALigaPlayerController()
{
	PrimaryActorTick.bCanEverTick = true;
	bShowMouseCursor = false;
}

void ALigaPlayerController::BeginPlay()
{
	Super::BeginPlay();
	ApplyInputMode();
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (GI && !GI->HasStarter() && !GI->Data.HasFlag(TEXT("intro")))
	{
		GI->Data.SetFlag(TEXT("intro"));
		ShowDialogue(TEXT("Мама"), {
			TEXT("Доброе утро! Сегодня особенный день."),
			TEXT("Профессор Оук обещал подарить тебе первого покемона."),
			TEXT("Его лаборатория на юге города. Удачи!"),
		});
	}
}

void ALigaPlayerController::Tick(float Dt)
{
	Super::Tick(Dt);
	ToastTime = FMath::Max(0.f, ToastTime - Dt);
	if (ULigaGameInstance* GI = ULigaGameInstance::Get(this))
	{
		GI->Data.PlaySeconds += Dt;
	}
	if (Mode == ELigaMode::Battle && Stage.IsValid() && !Stage->IsBusy() && BattleMenu == ELigaBattleMenu::None)
	{
		ULigaGameInstance* GI = ULigaGameInstance::Get(this);
		if (GI && GI->Battle)
		{
			switch (GI->Battle->Phase)
			{
			case ELigaBattlePhase::Choose: SetBattleMenu(ELigaBattleMenu::Main); break;
			case ELigaBattlePhase::ForceSwitch: SetBattleMenu(ELigaBattleMenu::ForceSwitch); break;
			case ELigaBattlePhase::Ended: SetBattleMenu(ELigaBattleMenu::Result); break;
			}
		}
	}
}

void ALigaPlayerController::SetMode(ELigaMode M)
{
	Mode = M;
	++UiSerial;
	ApplyInputMode();
}

void ALigaPlayerController::ApplyInputMode()
{
	if (Mode == ELigaMode::Explore || Mode == ELigaMode::Dialogue)
	{
		FInputModeGameOnly In;
		SetInputMode(In);
		SetShowMouseCursor(false);
	}
	else
	{
		FInputModeGameAndUI In;
		In.SetLockMouseToViewportBehavior(EMouseLockMode::LockAlways);
		In.SetHideCursorDuringCapture(false);
		SetInputMode(In);
		SetShowMouseCursor(true);
	}
}

void ALigaPlayerController::ShowToast(const FString& Text, float Seconds)
{
	Toast = Text;
	ToastTime = Seconds;
}

FString ALigaPlayerController::CurrentPlaceName() const
{
	const APawn* P = GetPawn();
	if (!P) return TEXT("Паллет-таун");
	for (TActorIterator<ALigaWorldBuilder> It(GetWorld()); It; ++It)
	{
		const FVector B = It->ToBlender(P->GetActorLocation());
		return B.Y > 47.f ? TEXT("Маршрут 1") : B.Y < -36.f ? TEXT("Берег Паллет-тауна") : TEXT("Паллет-таун");
	}
	return TEXT("Паллет-таун");
}

FString ALigaPlayerController::CurrentPrompt() const
{
	const ALigaCharacter* C = Cast<ALigaCharacter>(GetPawn());
	if (!C || !IsExploring()) return FString();
	if (const ILigaInteractable* I = Cast<ILigaInteractable>(C->Focus.Get()))
	{
		const FString Name = I->GetDisplayName();
		return Name.IsEmpty() ? I->GetPromptText() : FString::Printf(TEXT("%s: %s"), *I->GetPromptText(), *Name);
	}
	return FString();
}

// ——— dialogue ———

void ALigaPlayerController::ShowDialogue(const FString& InSpeaker, const TArray<FString>& InLines, TFunction<void()> Then)
{
	Speaker = InSpeaker;
	Lines = InLines.Num() ? InLines : TArray<FString>{TEXT("...")};
	LineIndex = 0;
	AfterDialogue = MoveTemp(Then);
	SetMode(ELigaMode::Dialogue);
}

void ALigaPlayerController::AdvanceDialogue()
{
	if (Mode != ELigaMode::Dialogue) return;
	if (LineIndex + 1 < Lines.Num())
	{
		++LineIndex;
		++UiSerial;
		return;
	}
	TFunction<void()> Then = MoveTemp(AfterDialogue);
	AfterDialogue = nullptr;
	SetMode(ULigaGameInstance::Get(this) && ULigaGameInstance::Get(this)->Battle ? ELigaMode::Battle : ELigaMode::Explore);
	if (Then) Then();
}

// ——— choices ———

void ALigaPlayerController::ShowChoice(const FString& Title, const TArray<FLigaChoice>& InChoices, TFunction<void(int32)> OnPick, bool bCancelable, bool bPictures)
{
	ChoiceTitle = Title;
	Choices = InChoices;
	++UiSerial;
	OnChoicePicked = MoveTemp(OnPick);
	bChoiceCancelable = bCancelable;
	bChoicePictures = bPictures;
	SetMode(ELigaMode::Choice);
}

void ALigaPlayerController::PickChoice(int32 Index)
{
	if (Mode != ELigaMode::Choice) return;
	if (Index >= 0 && (!Choices.IsValidIndex(Index) || !Choices[Index].bEnabled)) return;
	TFunction<void(int32)> Pick = MoveTemp(OnChoicePicked);
	OnChoicePicked = nullptr;
	SetMode(ULigaGameInstance::Get(this) && ULigaGameInstance::Get(this)->Battle ? ELigaMode::Battle : ELigaMode::Explore);
	if (Pick) Pick(Index);
}

// ——— story ———

void ALigaPlayerController::TalkToOak()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	if (!GI->HasStarter())
	{
		ShowDialogue(TEXT("Профессор Оук"), {
			TEXT("А, вот и ты! Я — Оук, люди зовут меня профессором покемонов."),
			TEXT("Этот мир населён удивительными созданиями — покемонами."),
			TEXT("На столе три покебола. Выбирай своего первого покемона!"),
		}, [this, GI]()
		{
			TArray<FLigaChoice> Starters;
			const int32 Ids[] = {1, 4, 7};
			const TCHAR* Notes[] = {TEXT("Травяной · спокойный и выносливый"), TEXT("Огненный · горячий нрав"), TEXT("Водный · надёжный защитник")};
			const TCHAR* Colors[] = {TEXT("7AC74C"), TEXT("EE8130"), TEXT("6390F0")};
			for (int32 i = 0; i < 3; ++i)
			{
				FLigaChoice C;
				const FLigaSpecies* S = FLigaDatabase::Get().Species(Ids[i]);
				C.Label = S ? S->Name : TEXT("?");
				C.Detail = Notes[i];
				C.Species = Ids[i];
				C.Color = FLinearColor(FColor::FromHex(Colors[i]));
				Starters.Add(C);
			}
			ShowChoice(TEXT("Кого выберешь?"), Starters, [this, GI](int32 Pick)
			{
				if (Pick < 0) return;
				const int32 Ids2[] = {1, 4, 7};
				GI->GiveStarter(Ids2[Pick]);
				const FString Name = LigaRules::DisplayName(GI->Data.Team[0]);
				GI->SaveGame();
				ShowDialogue(TEXT("Профессор Оук"), {
					FString::Printf(TEXT("%s! Отличный выбор. Береги его."), *Name),
					TEXT("Держи 5 покеболов и 3 зелья — пригодятся."),
					TEXT("Иди на север, на Маршрут 1. В высокой траве живут дикие покемоны!"),
				});
			}, false, true);
		});
		return;
	}
	const FLigaPokemon& Lead = GI->Data.Team[0];
	int32 Caught = 0;
	for (const TPair<int32, uint8>& D : GI->Data.Dex) Caught += D.Value >= 2 ? 1 : 0;
	ShowDialogue(TEXT("Профессор Оук"), {
		FString::Printf(TEXT("Как поживает %s? Вижу, вы отлично ладите!"), *LigaRules::DisplayName(Lead)),
		FString::Printf(TEXT("В твоём покедексе пойманных покемонов: %d. Продолжай в том же духе!"), Caught),
	});
}

void ALigaPlayerController::TalkToMom()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (GI && GI->HasStarter())
	{
		GI->HealTeam();
		RememberPosition();
		GI->SaveGame();
		ShowDialogue(TEXT("Мама"), {TEXT("Ты, наверное, устал? Отдохни немного."), TEXT("Твои покемоны полностью здоровы! Игра сохранена.")});
	}
	else
	{
		ShowDialogue(TEXT("Мама"), {TEXT("Профессор Оук ждёт тебя в лаборатории — это к югу от площади.")});
	}
}

// ——— battle ———

void ALigaPlayerController::TryWildEncounter(const FString& Route)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	APawn* P = GetPawn();
	if (!GI || !P || GI->Battle) return;
	if (!GI->HasStarter())
	{
		ShowDialogue(TEXT("Профессор Оук"), {
			TEXT("Эй, стой! Не ходи в высокую траву без покемона!"),
			TEXT("Дикие покемоны могут напасть. Зайди ко мне в лабораторию."),
		});
		P->SetActorLocation(P->GetActorLocation() - P->GetActorForwardVector() * 250.f, true);
		return;
	}
	if (GI->Data.FirstAliveIndex() == INDEX_NONE) return;
	int32 Species = 0;
	int32 Level = 0;
	if (!GI->RollWild(Route, Species, Level)) return;
	if (!GI->StartWildBattle(Species, Level, TEXT("Маршрут 1"))) return;
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	ALigaBattleStage* S = GetWorld()->SpawnActor<ALigaBattleStage>(P->GetActorLocation(), FRotator::ZeroRotator, Params);
	Stage = S;
	if (ACharacter* C = Cast<ACharacter>(P)) C->GetCharacterMovement()->StopMovementImmediately();
	BattleMenu = ELigaBattleMenu::None;
	SetMode(ELigaMode::Battle);
	S->Begin(P);
}

void ALigaPlayerController::SetBattleMenu(ELigaBattleMenu M)
{
	BattleMenu = M;
	++UiSerial;
}

void ALigaPlayerController::AfterTurn()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (GI && GI->Battle && Stage.IsValid()) Stage->Play(GI->Battle->Events);
	SetBattleMenu(ELigaBattleMenu::None);
}

void ALigaPlayerController::BattleMove(int32 Index)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI || !GI->Battle || BattleMenu != ELigaBattleMenu::Fight) return;
	FString Err;
	if (!GI->Battle->DoTurn(FLigaBattleAction::MakeMove(Index), Err))
	{
		ShowToast(Err);
		return;
	}
	AfterTurn();
}

void ALigaPlayerController::BattleItem(const FString& ItemId)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI || !GI->Battle) return;
	FString Err;
	if (!GI->Battle->DoTurn(FLigaBattleAction::MakeItem(ItemId), Err))
	{
		ShowToast(Err);
		return;
	}
	AfterTurn();
}

void ALigaPlayerController::BattleSwitch(int32 TeamIndex)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI || !GI->Battle) return;
	FString Err;
	const bool bOk = BattleMenu == ELigaBattleMenu::ForceSwitch ? GI->Battle->ForceSwitch(TeamIndex, Err)
	                                                            : GI->Battle->DoTurn(FLigaBattleAction::MakeSwitch(TeamIndex), Err);
	if (!bOk)
	{
		ShowToast(Err);
		return;
	}
	AfterTurn();
}

void ALigaPlayerController::BattleRun()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI || !GI->Battle) return;
	FString Err;
	if (!GI->Battle->DoTurn(FLigaBattleAction::MakeRun(), Err))
	{
		ShowToast(Err);
		return;
	}
	AfterTurn();
}

void ALigaPlayerController::BattleContinue()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI || !GI->Battle || BattleMenu != ELigaBattleMenu::Result) return;
	SetBattleMenu(ELigaBattleMenu::None);
	FLigaBattle& B = *GI->Battle;
	B.Close();
	PostBattleSteps.Reset();
	for (const FLigaPendingEvolution& Evo : B.PendingEvolutions)
	{
		PostBattleSteps.Add([this, GI, Evo]()
		{
			FLigaPokemon* P = GI->Data.FindByUid(Evo.Uid);
			const FLigaSpecies* To = FLigaDatabase::Get().Species(Evo.To);
			if (!P || !To)
			{
				RunPostBattle();
				return;
			}
			const FString Before = LigaRules::DisplayName(*P);
			LigaRules::Evolve(*P, Evo.To);
			GI->Data.MarkCaught(Evo.To);
			ShowDialogue(TEXT(""), {
				FString::Printf(TEXT("Что? %s эволюционирует!"), *Before),
				FString::Printf(TEXT("Поздравляем! %s превратился в %s!"), *Before, *To->Name),
			}, [this]() { RunPostBattle(); });
		});
	}
	for (const FLigaPendingLearn& L : B.PendingLearn)
	{
		PostBattleSteps.Add([this, GI, L]()
		{
			FLigaPokemon* P = GI->Data.FindByUid(L.Uid);
			const FLigaMove* M = FLigaDatabase::Get().Move(L.MoveId);
			if (!P || !M)
			{
				RunPostBattle();
				return;
			}
			TArray<FLigaChoice> Opts;
			for (const FLigaMoveSlot& Slot : P->Moves)
			{
				FLigaChoice C;
				const FLigaMove* Old = FLigaDatabase::Get().Move(Slot.Id);
				C.Label = Old ? Old->Name : Slot.Id;
				C.Detail = Old ? LigaTypes::Name(Old->Type) : FString();
				C.Color = Old ? LigaTypes::Color(Old->Type) : C.Color;
				Opts.Add(C);
			}
			FLigaChoice Keep;
			Keep.Label = FString::Printf(TEXT("Не изучать «%s»"), *M->Name);
			Opts.Add(Keep);
			const int32 Uid = L.Uid;
			const FString MoveId = L.MoveId;
			ShowChoice(FString::Printf(TEXT("%s хочет изучить «%s». Какую атаку забыть?"), *LigaRules::DisplayName(*P), *M->Name), Opts,
				[this, GI, Uid, MoveId](int32 Pick)
				{
					FLigaPokemon* Pk = GI->Data.FindByUid(Uid);
					if (Pk && Pick >= 0 && Pick < Pk->Moves.Num())
					{
						LigaRules::LearnMove(*Pk, MoveId, Pick);
						ShowToast(TEXT("Новая атака изучена!"));
					}
					RunPostBattle();
				});
		});
	}
	RunPostBattle();
}

void ALigaPlayerController::RunPostBattle()
{
	if (PostBattleSteps.Num() > 0)
	{
		TFunction<void()> Step = PostBattleSteps[0];
		PostBattleSteps.RemoveAt(0);
		Step();
		return;
	}
	FinishBattle();
}

void ALigaPlayerController::FinishBattle()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	const bool bLost = GI && GI->Battle && GI->Battle->Result == ELigaBattleResult::Lose;
	if (Stage.IsValid()) Stage->Finish();
	Stage = nullptr;
	if (bLost)
	{
		// Wake up at home.
		for (TActorIterator<ALigaWorldBuilder> It(GetWorld()); It; ++It)
		{
			if (APawn* P = GetPawn()) P->TeleportTo(It->PlayerStartWorld(), FRotator(0.f, It->PlayerStartYaw(), 0.f));
			break;
		}
	}
	RememberPosition();
	if (GI) GI->EndBattle();
	SetMode(ELigaMode::Explore);
	if (bLost) ShowDialogue(TEXT("Мама"), {TEXT("Ох, ты весь в пыли! Отдохни дома."), TEXT("Твои покемоны снова здоровы.")});
}

// ——— menu ———

void ALigaPlayerController::ToggleMenu()
{
	if (Mode == ELigaMode::Explore) SetMode(ELigaMode::Menu);
	else if (Mode == ELigaMode::Menu) SetMode(ELigaMode::Explore);
}

void ALigaPlayerController::RememberPosition()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	APawn* P = GetPawn();
	if (!GI || !P) return;
	GI->Data.bHasPosition = true;
	GI->Data.PlayerLocation = P->GetActorLocation();
	GI->Data.PlayerYaw = P->GetActorRotation().Yaw;
}

void ALigaPlayerController::SaveFromMenu()
{
	RememberPosition();
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	ShowToast(GI && GI->SaveGame() ? TEXT("Игра сохранена") : TEXT("Не удалось сохранить игру"));
}

void ALigaPlayerController::QuitGame()
{
	SaveFromMenu();
	UKismetSystemLibrary::QuitGame(this, this, EQuitPreference::Quit, false);
}

// ——— input ———

void ALigaPlayerController::OnConfirm()
{
	switch (Mode)
	{
	case ELigaMode::Dialogue:
		AdvanceDialogue();
		break;
	case ELigaMode::Battle:
		if (Stage.IsValid() && Stage->IsBusy()) Stage->SkipText();
		else if (BattleMenu == ELigaBattleMenu::Result) BattleContinue();
		else if (BattleMenu == ELigaBattleMenu::Main) SetBattleMenu(ELigaBattleMenu::Fight);
		break;
	default:
		break;
	}
}

void ALigaPlayerController::OnBack()
{
	switch (Mode)
	{
	case ELigaMode::Choice:
		if (bChoiceCancelable) PickChoice(-1);
		break;
	case ELigaMode::Battle:
		if (BattleMenu == ELigaBattleMenu::Fight || BattleMenu == ELigaBattleMenu::Bag || BattleMenu == ELigaBattleMenu::Team)
		{
			SetBattleMenu(ELigaBattleMenu::Main);
		}
		break;
	case ELigaMode::Menu:
		SetMode(ELigaMode::Explore);
		break;
	case ELigaMode::Explore:
		SetMode(ELigaMode::Menu);
		break;
	default:
		break;
	}
}

void ALigaPlayerController::OnNumberKey(int32 N)
{
	if (Mode == ELigaMode::Choice) PickChoice(N - 1);
	else if (Mode == ELigaMode::Battle && BattleMenu == ELigaBattleMenu::Fight) BattleMove(N - 1);
	else if (Mode == ELigaMode::Battle && BattleMenu == ELigaBattleMenu::Main)
	{
		if (N == 1) SetBattleMenu(ELigaBattleMenu::Fight);
		else if (N == 2) SetBattleMenu(ELigaBattleMenu::Team);
		else if (N == 3) SetBattleMenu(ELigaBattleMenu::Bag);
		else if (N == 4) BattleRun();
	}
}
