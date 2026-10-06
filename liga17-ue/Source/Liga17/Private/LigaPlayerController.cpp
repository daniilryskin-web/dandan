#include "LigaPlayerController.h"

#include "GameFramework/Character.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "Kismet/GameplayStatics.h"
#include "Kismet/KismetSystemLibrary.h"
#include "LigaBattleStage.h"
#include "LigaCharacter.h"
#include "LigaData.h"
#include "LigaAssets.h"
#include "LigaGameInstance.h"
#include "LigaInteractable.h"
#include "LigaNPC.h"
#include "LigaQuests.h"
#include "LigaWorldBuilder.h"
#include "EngineUtils.h"

namespace
{
	FLinearColor PcHex(const TCHAR* H) { return FLinearColor(FColor::FromHex(H)); }
}

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
	if (GI)
	{
		LigaQuests::Upgrade(GI->Data);
		if (!GI->HasStarter() && LigaQuests::State(GI->Data, TEXT("starter")) == 0)
		{
			if (const FLigaQuestDef* Q = LigaQuests::Find(TEXT("starter"))) LigaQuests::Start(GI->Data, *Q);
		}
	}
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
	UpdateTravel(Dt);
	UpdatePlace(Dt);
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

void ALigaPlayerController::UpdatePlace(float Dt)
{
	PlaceCheck -= Dt;
	if (PlaceCheck > 0.f) return;
	PlaceCheck = 0.25f;
	const APawn* P = GetPawn();
	if (!P) return;
	for (TActorIterator<ALigaWorldBuilder> It(GetWorld()); It; ++It)
	{
		if (const FLigaPlaceDef* Place = It->PlaceAtWorld(P->GetActorLocation()))
		{
			PlaceName = Place->Name;
			bIndoors = Place->bIndoor;
		}
		else
		{
			// Not in a named area (or an old layout.json without them): by how far north or south we are.
			const FVector B = It->ToBlender(P->GetActorLocation());
			PlaceName = B.Y > 47.f ? TEXT("Маршрут 1") : B.Y < -36.f ? TEXT("Берег Паллет-тауна") : TEXT("Паллет-таун");
			bIndoors = false;
		}
		break;
	}
}

// ——— doors ———

void ALigaPlayerController::TravelTo(const FVector& Where, float Yaw)
{
	if (bTraveling || Mode != ELigaMode::Explore) return;
	bTraveling = true;
	bTravelArrived = false;
	TravelWhere = Where;
	TravelYaw = Yaw;
	if (ACharacter* C = Cast<ACharacter>(GetPawn())) C->GetCharacterMovement()->StopMovementImmediately();
}

void ALigaPlayerController::UpdateTravel(float Dt)
{
	DoorCooldown = FMath::Max(0.f, DoorCooldown - Dt);
	if (!bTraveling) return;
	if (!bTravelArrived)
	{
		Fade = FMath::Min(1.f, Fade + Dt / 0.25f);
		if (Fade < 1.f) return;
		bTravelArrived = true;
		if (APawn* P = GetPawn())
		{
			P->TeleportTo(TravelWhere, FRotator(0.f, TravelYaw, 0.f), false, true);
			SetControlRotation(FRotator(-12.f, TravelYaw, 0.f));
			if (ALigaCharacter* C = Cast<ALigaCharacter>(P)) C->SnapCamera();
		}
		PlaceCheck = 0.f;
		RememberPosition();
		return;
	}
	Fade = FMath::Max(0.f, Fade - Dt / 0.4f);
	if (Fade <= 0.f)
	{
		bTraveling = false;
		DoorCooldown = 1.f;
	}
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
				CheckQuests();
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

FString ALigaPlayerController::NpcName(const FString& Id) const
{
	for (const FLigaNpcDef& N : FLigaLayout::Get().Npcs)
	{
		if (N.Id == Id) return N.Name;
	}
	return Id;
}

void ALigaPlayerController::QuestStarted(const FLigaQuestDef& Q)
{
	ShowToast(FString::Printf(TEXT("Новое задание: «%s». %s"), *Q.Title, *Q.Goal), 5.f);
	CheckQuests();
	if (ULigaGameInstance* GI = ULigaGameInstance::Get(this))
	{
		RememberPosition();
		GI->SaveGame();
	}
}

void ALigaPlayerController::CheckQuests()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	FLigaGameData& D = GI->Data;
	TArray<FString> Notes;
	for (const FLigaQuestDef& Q : LigaQuests::All())
	{
		if (LigaQuests::State(D, Q.Id) != 1 || !LigaQuests::IsComplete(D, Q)) continue;
		if (Q.TurnIn.IsEmpty())
		{
			const FString Reward = LigaQuests::Finish(D, Q);
			Notes.Add(FString::Printf(TEXT("Задание «%s» выполнено! %s"), *Q.Title, *Reward));
		}
		else if (!AnnouncedQuests.Contains(Q.Id))
		{
			AnnouncedQuests.Add(Q.Id);
			Notes.Add(FString::Printf(TEXT("«%s»: цель достигнута! Вернитесь к: %s"), *Q.Title, *NpcName(Q.TurnIn)));
		}
	}
	if (Notes.Num()) ShowToast(FString::Join(Notes, TEXT("\n")), 5.f);
}

void ALigaPlayerController::TalkToNpc(ALigaNPC* Npc)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!Npc || !GI) return;
	FLigaGameData& D = GI->Data;
	const FString Id = Npc->Id;
	const FString Name = Npc->DisplayName;
	// 1. Reporting a finished quest.
	for (const FLigaQuestDef& Q : LigaQuests::All())
	{
		if (LigaQuests::State(D, Q.Id) != 1 || Q.TurnIn != Id) continue;
		if (Q.Kind != ELigaQuestGoal::Talk && !LigaQuests::IsComplete(D, Q)) continue;
		const FString Reward = LigaQuests::Finish(D, Q);
		const FString Title = Q.Title;
		RememberPosition();
		GI->SaveGame();
		ShowDialogue(Name, Q.Done.Num() ? Q.Done : TArray<FString>{TEXT("Спасибо!")}, [this, Title, Reward]()
		{
			ShowToast(FString::Printf(TEXT("Задание «%s» выполнено! %s"), *Title, *Reward), 5.f);
		});
		return;
	}
	// 2. The professor gives the first Pokémon before anything else.
	if (Id == TEXT("oak") && !GI->HasStarter())
	{
		TalkToOak();
		return;
	}
	// 3. A new quest.
	for (const FLigaQuestDef& Q : LigaQuests::All())
	{
		if (Q.Giver != Id || !LigaQuests::IsAvailable(D, Q)) continue;
		LigaQuests::Start(D, Q);
		const FLigaQuestDef* Started = &Q;  // the quest table is static
		ShowDialogue(Name, Q.Offer, [this, Started]() { QuestStarted(*Started); });
		return;
	}
	// 4. What this person does.
	if (Id == TEXT("mom"))
	{
		TalkToMom();
		return;
	}
	if (Id == TEXT("nurse"))
	{
		NurseHeal(Name);
		return;
	}
	if (Id == TEXT("clerk"))
	{
		OpenShop(Name);
		return;
	}
	// 5. A reminder about a quest in progress.
	for (const FLigaQuestDef& Q : LigaQuests::All())
	{
		if (LigaQuests::State(D, Q.Id) == 1 && (Q.TurnIn == Id || Q.Giver == Id) && Q.Remind.Num())
		{
			ShowDialogue(Name, LigaQuests::WithProgress(D, Q, Q.Remind));
			return;
		}
	}
	if (Id == TEXT("oak"))
	{
		TalkToOak();
		return;
	}
	ShowDialogue(Name, Npc->Lines);
}

void ALigaPlayerController::NurseHeal(const FString& Speaker)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	if (!GI->HasStarter())
	{
		ShowDialogue(Speaker, {TEXT("Добро пожаловать в Покецентр!"), TEXT("Когда у вас появятся покемоны, я с радостью их вылечу.")});
		return;
	}
	FLigaChoice Yes;
	Yes.Label = TEXT("Да, пожалуйста");
	Yes.Detail = TEXT("Здоровье, PP и статусы всей команды");
	Yes.Color = PcHex(TEXT("D9487A"));
	FLigaChoice No;
	No.Label = TEXT("Нет, спасибо");
	ShowChoice(TEXT("Добро пожаловать в Покецентр! Вылечить ваших покемонов?"), {Yes, No}, [this, GI, Speaker](int32 Pick)
	{
		if (Pick != 0)
		{
			ShowDialogue(Speaker, {TEXT("Приходите ещё!")});
			return;
		}
		GI->HealTeam();
		LigaQuests::AddCounter(GI->Data, TEXT("heal_center"));
		RememberPosition();
		GI->SaveGame();
		ShowDialogue(Speaker, {TEXT("Минутку..."), TEXT("Ваши покемоны полностью здоровы! Игра сохранена."), TEXT("Приходите ещё!")}, [this]() { CheckQuests(); });
	}, true);
}

void ALigaPlayerController::OpenShop(const FString& Speaker)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	static const TCHAR* Stock[] = {
		TEXT("poke-ball"), TEXT("great-ball"), TEXT("ultra-ball"), TEXT("potion"), TEXT("super-potion"), TEXT("hyper-potion"), TEXT("antidote"),
		TEXT("paralyze-heal"), TEXT("awakening"), TEXT("burn-heal"), TEXT("ice-heal"), TEXT("full-heal"), TEXT("revive"), TEXT("ether"),
	};
	TArray<FLigaChoice> Opts;
	TArray<FString> Ids;
	for (const TCHAR* Id : Stock)
	{
		const FLigaItem* It = FLigaDatabase::Get().Item(Id);
		if (!It) continue;
		FLigaChoice C;
		C.Label = FString::Printf(TEXT("%s — %d"), *It->Name, It->Price);
		C.Detail = FString::Printf(TEXT("В сумке: %d · %s"), GI->Data.ItemCount(It->Id), *It->Desc);
		C.Color = It->Kind == TEXT("ball") ? PcHex(TEXT("D94A3D")) : It->Kind == TEXT("heal") ? PcHex(TEXT("2F9E5B"))
			: It->Kind == TEXT("status") ? PcHex(TEXT("C98A1E")) : PcHex(TEXT("7A55C9"));
		C.bEnabled = GI->Data.Money >= It->Price;
		Opts.Add(C);
		Ids.Add(It->Id);
	}
	FLigaChoice Leave;
	Leave.Label = TEXT("Уйти");
	Opts.Add(Leave);
	ShowChoice(FString::Printf(TEXT("Магазин · у вас %d монет"), GI->Data.Money), Opts, [this, Ids, Speaker](int32 Pick)
	{
		if (!Ids.IsValidIndex(Pick))
		{
			ShowDialogue(Speaker, {TEXT("Спасибо за покупки! Приходите ещё.")});
			return;
		}
		BuyAmount(Speaker, Ids[Pick]);
	}, true);
}

void ALigaPlayerController::BuyAmount(const FString& Speaker, const FString& ItemId)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	const FLigaItem* It = FLigaDatabase::Get().Item(ItemId);
	if (!GI || !It) return;
	TArray<FLigaChoice> Opts;
	for (int32 N : {1, 5, 10})
	{
		FLigaChoice C;
		C.Label = FString::Printf(TEXT("×%d — %d монет"), N, N * It->Price);
		C.Color = PcHex(TEXT("2F7BFF"));
		C.bEnabled = GI->Data.Money >= N * It->Price;
		Opts.Add(C);
	}
	FLigaChoice Back;
	Back.Label = TEXT("Назад");
	Opts.Add(Back);
	ShowChoice(FString::Printf(TEXT("%s · у вас %d монет. Сколько купить?"), *It->Name, GI->Data.Money), Opts, [this, Speaker, ItemId](int32 Pick)
	{
		ULigaGameInstance* G = ULigaGameInstance::Get(this);
		const FLigaItem* I = FLigaDatabase::Get().Item(ItemId);
		const int32 N = Pick == 0 ? 1 : Pick == 1 ? 5 : Pick == 2 ? 10 : 0;
		if (G && I && N > 0 && G->Data.Money >= N * I->Price)
		{
			G->Data.Money -= N * I->Price;
			G->Data.AddItem(ItemId, N);
			LigaQuests::AddCounter(G->Data, TEXT("buy:") + ItemId, N);
			ShowToast(FString::Printf(TEXT("Куплено: %s ×%d (−%d монет)"), *I->Name, N, N * I->Price));
			CheckQuests();
		}
		OpenShop(Speaker);
	}, true);
}

void ALigaPlayerController::OpenStorage()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	const FLigaGameData& D = GI->Data;
	FLigaChoice Take;
	Take.Label = TEXT("Забрать покемона");
	Take.Detail = FString::Printf(TEXT("В хранилище: %d"), D.Storage.Num());
	Take.Color = PcHex(TEXT("2F7BFF"));
	Take.bEnabled = D.Storage.Num() > 0 && D.Team.Num() < LigaRules::MaxTeam;
	FLigaChoice Put;
	Put.Label = TEXT("Оставить покемона");
	Put.Detail = FString::Printf(TEXT("В команде: %d из %d"), D.Team.Num(), LigaRules::MaxTeam);
	Put.Color = PcHex(TEXT("22A35A"));
	Put.bEnabled = D.Team.Num() > 1;
	FLigaChoice Off;
	Off.Label = TEXT("Выключить");
	ShowChoice(TEXT("Компьютер · хранилище покемонов"), {Take, Put, Off}, [this](int32 Pick)
	{
		if (Pick == 0) StorageList(true);
		else if (Pick == 1) StorageList(false);
	}, true);
}

void ALigaPlayerController::StorageList(bool bWithdraw)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	const TArray<FLigaPokemon>& From = bWithdraw ? GI->Data.Storage : GI->Data.Team;
	TArray<FLigaChoice> Opts;
	TArray<int32> Uids;
	for (const FLigaPokemon& P : From)
	{
		if (Opts.Num() >= 15) break;
		FLigaChoice C;
		C.Label = FString::Printf(TEXT("%s  ур. %d"), *LigaRules::DisplayName(P), P.Level);
		C.Detail = FString::Printf(TEXT("HP %d/%d"), P.HP, LigaRules::MaxHp(P));
		C.Color = PcHex(TEXT("3B4A7A"));
		Opts.Add(C);
		Uids.Add(P.Uid);
	}
	FLigaChoice Back;
	Back.Label = TEXT("Назад");
	Opts.Add(Back);
	ShowChoice(bWithdraw ? TEXT("Кого забрать в команду?") : TEXT("Кого оставить в хранилище?"), Opts, [this, bWithdraw, Uids](int32 Pick)
	{
		ULigaGameInstance* G = ULigaGameInstance::Get(this);
		if (G && Uids.IsValidIndex(Pick))
		{
			FLigaGameData& Dd = G->Data;
			TArray<FLigaPokemon>& Src = bWithdraw ? Dd.Storage : Dd.Team;
			TArray<FLigaPokemon>& Dst = bWithdraw ? Dd.Team : Dd.Storage;
			const int32 Uid = Uids[Pick];
			const int32 Idx = Src.IndexOfByPredicate([Uid](const FLigaPokemon& P) { return P.Uid == Uid; });
			const bool bRoom = bWithdraw ? Dd.Team.Num() < LigaRules::MaxTeam : Dd.Team.Num() > 1;
			if (Idx != INDEX_NONE && bRoom)
			{
				const FLigaPokemon Moved = Src[Idx];
				Src.RemoveAt(Idx);
				Dst.Add(Moved);
				const FString Name = LigaRules::DisplayName(Moved);
				ShowToast(bWithdraw ? FString::Printf(TEXT("%s теперь в команде"), *Name) : FString::Printf(TEXT("%s отправлен в хранилище"), *Name));
			}
		}
		OpenStorage();
	}, true);
}

// ——— battle ———

void ALigaPlayerController::TryWildEncounter(const FString& Route, const FString& Place)
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
	if (!GI->StartWildBattle(Species, Level, Place.IsEmpty() ? PlaceName : Place)) return;
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
	if (GI && GI->Battle && GI->Battle->Result == ELigaBattleResult::Caught)
	{
		// Quests count caught Pokémon by type ("catch_type:water").
		for (EPokeType T : LigaRules::TypesOf(GI->Battle->EnemyMon())) LigaQuests::AddCounter(GI->Data, TEXT("catch_type:") + LigaQuests::TypeId(T));
	}
	if (GI) GI->EndBattle();
	SetMode(ELigaMode::Explore);
	CheckQuests();
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
