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
	UpdateFishing(Dt);
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
	if (Mode == ELigaMode::Explore || Mode == ELigaMode::Dialogue || Mode == ELigaMode::Fishing)
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
		const FVector B = It->ToBlender(P->GetActorLocation());
		const FLigaPlaceDef* Place = It->PlaceAtWorld(P->GetActorLocation());
		if (Place)
		{
			PlaceName = Place->Name;
			bIndoors = Place->bIndoor;
		}
		else
		{
			// Not in a named area (or an old layout.json without them): by how far north or south we are.
			PlaceName = B.Y > 47.f ? TEXT("Маршрут 1") : B.Y < -36.f ? TEXT("Берег Паллет-тауна") : TEXT("Паллет-таун");
			bIndoors = false;
		}
		// New Bark Town lies far to the east; its rooms are named *_j (and Professor Elm's lab).
		const bool bJohto = B.X > 600.0 || (Place && (Place->Id.EndsWith(TEXT("_j")) || Place->Id == TEXT("elmlab")));
		Region = bJohto ? TEXT("ДЖОТО") : TEXT("КАНТО");
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
	// 2. The professor gives the first Pokémon before anything else; a trainer you have not beaten wants a battle;
	//    the fisherman lends his old rod.
	if (Id == TEXT("oak") && !GI->HasStarter())
	{
		TalkToOak();
		return;
	}
	if (Npc->IsTrainer() && Npc->WantsBattle() && GI->HasStarter() && D.FirstAliveIndex() != INDEX_NONE)
	{
		ChallengeTrainer(Npc);
		return;
	}
	if (Id == TEXT("fisher") && GI->HasStarter() && D.ItemCount(TEXT("old-rod")) <= 0)
	{
		ShowDialogue(Name, {
			TEXT("Эй, юный тренер! Любишь рыбалку?"),
			TEXT("Держи мою старую удочку — я себе новую купил."),
			TEXT("Встань на краю мостков или пристани и нажми E. Когда клюнет — жми E ещё раз, да побыстрее!"),
		}, [this]()
		{
			if (ULigaGameInstance* G = ULigaGameInstance::Get(this)) G->Data.AddItem(TEXT("old-rod"), 1);
			ShowToast(TEXT("Получено: Старая удочка"), 4.f);
		});
		return;
	}
	if (Id == TEXT("elm") && GI->HasStarter() && !D.HasFlag(TEXT("elm_gift")))
	{
		TalkToElm(Name);
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
	if (Id.StartsWith(TEXT("nurse")))
	{
		NurseHeal(Name);
		return;
	}
	if (Id == TEXT("clerk_market"))
	{
		OpenMarket(Name);
		return;
	}
	if (Id.StartsWith(TEXT("clerk")))
	{
		ShopCategory = 0;
		OpenShop(Name);
		return;
	}
	if (Id.StartsWith(TEXT("clubgirl")))
	{
		OpenTradeClub(Name);
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

void ALigaPlayerController::NurseHeal(const FString& Who)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	if (!GI->HasStarter())
	{
		ShowDialogue(Who, {TEXT("Добро пожаловать в Покецентр!"), TEXT("Когда у вас появятся покемоны, я с радостью их вылечу.")});
		return;
	}
	FLigaChoice Yes;
	Yes.Label = TEXT("Да, пожалуйста");
	Yes.Detail = TEXT("Здоровье, PP и статусы всей команды");
	Yes.Color = PcHex(TEXT("D9487A"));
	FLigaChoice No;
	No.Label = TEXT("Нет, спасибо");
	ShowChoice(TEXT("Добро пожаловать в Покецентр! Вылечить ваших покемонов?"), {Yes, No}, [this, GI, Who](int32 Pick)
	{
		if (Pick != 0)
		{
			ShowDialogue(Who, {TEXT("Приходите ещё!")});
			return;
		}
		GI->HealTeam();
		LigaQuests::AddCounter(GI->Data, TEXT("heal_center"));
		RememberPosition();
		GI->SaveGame();
		ShowDialogue(Who, {TEXT("Минутку..."), TEXT("Ваши покемоны полностью здоровы! Игра сохранена."), TEXT("Приходите ещё!")}, [this]() { CheckQuests(); });
	}, true);
}

void ALigaPlayerController::OpenShop(const FString& Who)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	// 0 the Mart; the market stall: 1 evolution stones, 2 items for trades, 3 rare items and the Soothe Bell.
	TArray<FString> Stock;
	switch (ShopCategory)
	{
	case 1:
		Stock = {TEXT("fire-stone"), TEXT("water-stone"), TEXT("thunder-stone"), TEXT("leaf-stone"), TEXT("moon-stone"), TEXT("sun-stone"),
			TEXT("ice-stone"), TEXT("shiny-stone"), TEXT("dusk-stone")};
		break;
	case 2:
		Stock = {TEXT("kings-rock"), TEXT("metal-coat"), TEXT("dragon-scale"), TEXT("up-grade"), TEXT("dubious-disc"), TEXT("protector"),
			TEXT("electirizer"), TEXT("magmarizer")};
		break;
	case 3:
		Stock = {TEXT("soothe-bell"), TEXT("razor-claw"), TEXT("razor-fang"), TEXT("black-augurite"), TEXT("peat-block")};
		break;
	default:
		Stock = {TEXT("poke-ball"), TEXT("great-ball"), TEXT("ultra-ball"), TEXT("potion"), TEXT("super-potion"), TEXT("hyper-potion"), TEXT("antidote"),
			TEXT("paralyze-heal"), TEXT("awakening"), TEXT("burn-heal"), TEXT("ice-heal"), TEXT("full-heal"), TEXT("revive"), TEXT("ether")};
		break;
	}
	TArray<FLigaChoice> Opts;
	TArray<FString> Ids;
	for (const FString& Id : Stock)
	{
		const FLigaItem* It = FLigaDatabase::Get().Item(Id);
		if (!It) continue;
		FLigaChoice C;
		C.Label = FString::Printf(TEXT("%s — %d"), *It->Name, It->Price);
		C.Detail = FString::Printf(TEXT("В сумке: %d · %s"), GI->Data.ItemCount(It->Id), *It->Desc);
		C.Color = It->Kind == TEXT("ball") ? PcHex(TEXT("D94A3D")) : It->Kind == TEXT("heal") ? PcHex(TEXT("2F9E5B"))
			: It->Kind == TEXT("status") ? PcHex(TEXT("C98A1E")) : It->Kind == TEXT("evo") ? PcHex(TEXT("2F8FB0"))
			: It->Kind == TEXT("trade") ? PcHex(TEXT("3E6FD9")) : It->Kind == TEXT("friend") ? PcHex(TEXT("D9487A")) : PcHex(TEXT("7A55C9"));
		C.bEnabled = GI->Data.Money >= It->Price;
		Opts.Add(C);
		Ids.Add(It->Id);
	}
	FLigaChoice Leave;
	Leave.Label = ShopCategory == 0 ? TEXT("Уйти") : TEXT("Назад к прилавку");
	Opts.Add(Leave);
	const FString Title = ShopCategory == 0 ? FString(TEXT("Магазин")) : FString(TEXT("Рынок"));
	ShowChoice(FString::Printf(TEXT("%s · у вас %d монет"), *Title, GI->Data.Money), Opts, [this, Ids, Who](int32 Pick)
	{
		if (!Ids.IsValidIndex(Pick))
		{
			if (ShopCategory != 0) OpenMarket(Who);
			else ShowDialogue(Who, {TEXT("Спасибо за покупки! Приходите ещё.")});
			return;
		}
		BuyAmount(Who, Ids[Pick]);
	}, true);
}

void ALigaPlayerController::OpenMarket(const FString& Who)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	struct FStall { const TCHAR* Label; const TCHAR* Detail; const TCHAR* Color; };
	const FStall Stalls[] = {
		{TEXT("Камни эволюции"), TEXT("Огненный, водный, громовой, листовой, лунный…"), TEXT("2F8FB0")},
		{TEXT("Предметы для обмена"), TEXT("Покемон держит их при обмене в Клубе тренеров"), TEXT("3E6FD9")},
		{TEXT("Редкие предметы"), TEXT("Успокаивающий колокольчик, острый коготь…"), TEXT("D9487A")},
	};
	TArray<FLigaChoice> Opts;
	for (const FStall& St : Stalls)
	{
		FLigaChoice C;
		C.Label = St.Label;
		C.Detail = St.Detail;
		C.Color = PcHex(St.Color);
		Opts.Add(C);
	}
	FLigaChoice Leave;
	Leave.Label = TEXT("Уйти");
	Opts.Add(Leave);
	ShowChoice(FString::Printf(TEXT("Рынок · у вас %d монет. Что посмотреть?"), GI->Data.Money), Opts, [this, Who](int32 Pick)
	{
		if (Pick < 0 || Pick > 2)
		{
			ShopCategory = 0;
			ShowDialogue(Who, {TEXT("Заходите ещё! Каждый день — новые находки.")});
			return;
		}
		ShopCategory = Pick + 1;
		OpenShop(Who);
	}, true);
}

// ——— trades at the Trainers' Club ———

void ALigaPlayerController::OpenTradeClub(const FString& Who)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	TArray<FLigaChoice> Opts;
	TArray<int32> Uids;
	for (const FLigaPokemon& Pk : GI->Data.Team)
	{
		FString Held;
		const int32 To = LigaRules::TradeEvolution(Pk, Held);
		const FLigaSpecies* Target = FLigaDatabase::Get().Species(To);
		if (!Target) continue;
		const FLigaItem* Item = Held.IsEmpty() ? nullptr : FLigaDatabase::Get().Item(Held);
		const int32 Have = Held.IsEmpty() ? 1 : GI->Data.ItemCount(Held);
		FLigaChoice C;
		C.Label = FString::Printf(TEXT("%s  ур. %d  →  %s"), *LigaRules::DisplayName(Pk), Pk.Level, *Target->Name);
		C.Detail = Held.IsEmpty() ? FString(TEXT("Эволюционирует при обмене"))
			: FString::Printf(TEXT("Нужен предмет «%s» (в сумке: %d). Продаётся на рынке"), Item ? *Item->Name : *Held, Have);
		C.Color = PcHex(TEXT("3E6FD9"));
		C.bEnabled = Have > 0;
		Opts.Add(C);
		Uids.Add(Pk.Uid);
	}
	if (Uids.Num() == 0)
	{
		ShowDialogue(Who, {
			TEXT("Добро пожаловать в Клуб тренеров! Здесь тренеры меняются покемонами."),
			TEXT("Некоторые покемоны эволюционируют, когда их обменивают: Кадабра, Мачок, Гравелер, Хонтер."),
			TEXT("А Поливирл, Слоупок, Оникс, Скайтер, Сидра и Поригон — только если держат особый предмет. Такие предметы продаёт торговка на рынке."),
			TEXT("Сейчас в вашей команде таких покемонов нет. Приходите, когда появятся!"),
		});
		return;
	}
	FLigaChoice Back;
	Back.Label = TEXT("Не сейчас");
	Opts.Add(Back);
	ShowChoice(TEXT("Клуб тренеров · обмен с партнёром. Кого отправить? Он вернётся к вам уже эволюционировавшим."), Opts, [this, Uids, Who](int32 Pick)
	{
		ULigaGameInstance* G = ULigaGameInstance::Get(this);
		if (!G || !Uids.IsValidIndex(Pick)) return;
		FLigaPokemon* P = G->Data.FindByUid(Uids[Pick]);
		if (!P) return;
		FString Held;
		const int32 To = LigaRules::TradeEvolution(*P, Held);
		const FLigaSpecies* Target = FLigaDatabase::Get().Species(To);
		if (!Target || (!Held.IsEmpty() && G->Data.ItemCount(Held) <= 0)) return;
		if (!Held.IsEmpty()) G->Data.Bag.FindOrAdd(Held) -= 1;
		const FString Before = LigaRules::DisplayName(*P);
		LigaRules::Evolve(*P, To);
		G->Data.MarkCaught(To);
		LigaQuests::AddCounter(G->Data, TEXT("trade_evolve"));
		RememberPosition();
		G->SaveGame();
		ShowDialogue(Who, {
			FString::Printf(TEXT("Отправляем %s партнёру по обмену…"), *Before),
			TEXT("Партнёр бережно возвращает покемона обратно — с благодарственной открыткой!"),
			FString::Printf(TEXT("Что? %s эволюционирует!"), *Before),
			FString::Printf(TEXT("Поздравляем! %s превратился в %s!"), *Before, *Target->Name),
		}, [this]() { CheckQuests(); });
	}, true);
}

void ALigaPlayerController::BuyAmount(const FString& Who, const FString& ItemId)
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
	ShowChoice(FString::Printf(TEXT("%s · у вас %d монет. Сколько купить?"), *It->Name, GI->Data.Money), Opts, [this, Who, ItemId](int32 Pick)
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
		OpenShop(Who);
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
	TrainerNpcId.Reset();
	BeginBattleStage();
}

void ALigaPlayerController::BeginBattleStage()
{
	APawn* P = GetPawn();
	if (!P) return;
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	ALigaBattleStage* S = GetWorld()->SpawnActor<ALigaBattleStage>(P->GetActorLocation(), FRotator::ZeroRotator, Params);
	Stage = S;
	if (ACharacter* C = Cast<ACharacter>(P)) C->GetCharacterMovement()->StopMovementImmediately();
	BattleMenu = ELigaBattleMenu::None;
	SetMode(ELigaMode::Battle);
	if (S) S->Begin(P);
}

// ——— trainers ———

int32 ALigaPlayerController::RivalStarter() const
{
	const ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return 133;
	// The first Pokémon you ever got has the smallest id.
	const FLigaPokemon* First = nullptr;
	for (const TArray<FLigaPokemon>* List : {&GI->Data.Team, &GI->Data.Storage})
	{
		for (const FLigaPokemon& Pk : *List)
		{
			if (!First || Pk.Uid < First->Uid) First = &Pk;
		}
	}
	const int32 Sp = First ? First->Species : 0;
	if (Sp >= 1 && Sp <= 3) return 4;   // grass -> the rival takes fire
	if (Sp >= 4 && Sp <= 6) return 7;   // fire -> water
	if (Sp >= 7 && Sp <= 9) return 1;   // water -> grass
	return 133;
}

void ALigaPlayerController::ChallengeTrainer(ALigaNPC* Npc)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!Npc || !GI || !IsExploring() || GI->Battle) return;
	const FLigaNpcDef* Def = FLigaLayout::Get().FindNpc(Npc->Id);
	if (!Def || !Def->bTrainer) return;
	Npc->Attend(8.f);
	if (ACharacter* C = Cast<ACharacter>(GetPawn())) C->GetCharacterMovement()->StopMovementImmediately();
	const FString NpcId = Npc->Id;
	const FString Name = Npc->DisplayName;
	TArray<FString> Before = Def->Trainer.Before;
	if (Before.Num() == 0) Before.Add(TEXT("Эй! Давай сразимся!"));
	ShowDialogue(Name, Before, [this, NpcId, Name]() { StartTrainerBattle(NpcId, Name); });
}

void ALigaPlayerController::StartTrainerBattle(const FString& NpcId, const FString& Name)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	const FLigaNpcDef* Def = FLigaLayout::Get().FindNpc(NpcId);
	if (!GI || !Def || GI->Battle || !GetPawn()) return;
	TArray<FIntPoint> Team = Def->Trainer.Team;
	for (FIntPoint& Member : Team)
	{
		if (Member.X < 0) Member.X = RivalStarter();
	}
	if (!GI->StartTrainerBattle(Name, Team, Def->Trainer.Prize, PlaceName)) return;
	TrainerNpcId = NpcId;
	bFishingBattle = false;
	BeginBattleStage();
}

void ALigaPlayerController::TalkToElm(const FString& Who)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	ShowDialogue(Who, {
		TEXT("А, гость из Канто! Я — профессор Элм. Изучаю, как покемоны растут и эволюционируют."),
		TEXT("Раз ты приехал так издалека — возьми одного из покемонов Джото. Они у меня на столе."),
	}, [this, Who]()
	{
		TArray<FLigaChoice> Gifts;
		const int32 Ids[] = {152, 155, 158};
		const TCHAR* Notes[] = {TEXT("Травяной · добрый и стойкий"), TEXT("Огненный · робкий, но горячий"), TEXT("Водный · весёлый и кусачий")};
		const TCHAR* Colors[] = {TEXT("7AC74C"), TEXT("EE8130"), TEXT("6390F0")};
		for (int32 i = 0; i < 3; ++i)
		{
			FLigaChoice C;
			const FLigaSpecies* S = FLigaDatabase::Get().Species(Ids[i]);
			C.Label = S ? S->Name : TEXT("?");
			C.Detail = Notes[i];
			C.Species = Ids[i];
			C.Color = PcHex(Colors[i]);
			Gifts.Add(C);
		}
		ShowChoice(TEXT("Кого возьмёшь?"), Gifts, [this, Who](int32 Pick)
		{
			ULigaGameInstance* G = ULigaGameInstance::Get(this);
			if (!G || Pick < 0 || Pick > 2) return;
			const int32 Ids2[] = {152, 155, 158};
			FLigaPokemon Gift = LigaRules::CreatePokemon(Ids2[Pick], 5, G->Rng, G->Data.NextUid++, 0);
			Gift.MetAt = TEXT("Нью-Барк");
			const bool bToStorage = G->Data.Team.Num() >= LigaRules::MaxTeam;
			if (bToStorage) G->Data.Storage.Add(Gift);
			else G->Data.Team.Add(Gift);
			G->Data.MarkCaught(Gift.Species);
			G->Data.SetFlag(TEXT("elm_gift"));
			RememberPosition();
			G->SaveGame();
			const FString Name = LigaRules::DisplayName(Gift);
			TArray<FString> Lines2 = {FString::Printf(TEXT("%s теперь с тобой! Береги его."), *Name)};
			if (bToStorage) Lines2.Add(TEXT("В команде нет места, поэтому он отправлен в хранилище. Забери его через компьютер в Покецентре."));
			Lines2.Add(TEXT("На Маршруте 29 к западу отсюда живут покемоны Джото. Удачи!"));
			ShowDialogue(Who, Lines2, [this]() { CheckQuests(); });
		}, false, true);
	});
}

// ——— the train ———

void ALigaPlayerController::RideTrain(const FString& Title, const FVector& Where, float Yaw)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI || !IsExploring()) return;
	if (!GI->HasStarter())
	{
		ShowDialogue(TEXT("Проводница"), {
			TEXT("Ой, а где твой покемон? Без покемона путешествовать одному нельзя!"),
			TEXT("Сначала загляни к профессору Оуку."),
		});
		return;
	}
	FLigaChoice Go;
	Go.Label = TEXT("Да, поехали!");
	Go.Detail = TEXT("Поезд отправляется сразу");
	Go.Color = PcHex(TEXT("2F7BFF"));
	FLigaChoice Stay;
	Stay.Label = TEXT("Нет, ещё погуляю");
	const FVector To = Where;
	ShowChoice(Title + TEXT("?"), {Go, Stay}, [this, To, Yaw](int32 Pick)
	{
		if (Pick != 0) return;
		if (ULigaGameInstance* G = ULigaGameInstance::Get(this)) LigaQuests::AddCounter(G->Data, TEXT("train_ride"));
		ShowToast(TEXT("Поезд отправляется… Чух-чух!"), 3.f);
		TravelTo(To, Yaw);
	}, true);
}

// ——— fishing ———

void ALigaPlayerController::StartFishing(const FString& SpotId, const FString& Title)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI || !IsExploring()) return;
	if (GI->Data.ItemCount(TEXT("old-rod")) <= 0)
	{
		ShowDialogue(Title, {
			TEXT("Здесь наверняка хорошо клюёт… но у вас нет удочки."),
			TEXT("Рыбак Фёдор у пруда в Паллет-тауне охотно одолжит свою."),
		});
		return;
	}
	if (!GI->HasStarter() || GI->Data.FirstAliveIndex() == INDEX_NONE)
	{
		ShowDialogue(Title, {TEXT("Без здорового покемона рыбачить опасно: вдруг клюнет кто-то большой!")});
		return;
	}
	FishSpot = SpotId;
	bFishBite = false;
	FishTimer = FMath::FRandRange(1.8f, 5.5f);
	if (ACharacter* C = Cast<ACharacter>(GetPawn())) C->GetCharacterMovement()->StopMovementImmediately();
	SetMode(ELigaMode::Fishing);
}

void ALigaPlayerController::UpdateFishing(float Dt)
{
	if (Mode != ELigaMode::Fishing) return;
	FishTimer -= Dt;
	if (FishTimer > 0.f) return;
	if (!bFishBite)
	{
		bFishBite = true;  // about a second to press E
		FishTimer = 1.1f;
		return;
	}
	StopFishing(TEXT("Рыба сорвалась! Жмите E сразу, как увидите «Клюёт!»."));
}

void ALigaPlayerController::FishingConfirm()
{
	if (Mode != ELigaMode::Fishing) return;
	if (!bFishBite)
	{
		StopFishing(TEXT("Слишком рано — рыба испугалась и уплыла."));
		return;
	}
	bFishBite = false;
	SetMode(ELigaMode::Explore);
	FString Route = FishSpot;
	Route.ReplaceInline(TEXT("fish_"), TEXT("fishing_"));
	if (ULigaGameInstance* GI = ULigaGameInstance::Get(this)) LigaQuests::AddCounter(GI->Data, TEXT("fish_hook"));
	TryWildEncounter(Route, PlaceName);
	bFishingBattle = Mode == ELigaMode::Battle;
}

void ALigaPlayerController::StopFishing(const FString& Message)
{
	bFishBite = false;
	if (Mode == ELigaMode::Fishing) SetMode(ELigaMode::Explore);
	if (!Message.IsEmpty()) ShowToast(Message, 3.f);
}

// ——— the bag outside battle ———

void ALigaPlayerController::OpenBag()
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI) return;
	TArray<FLigaChoice> Opts;
	TArray<FString> Ids;
	for (const FLigaItem& It : FLigaDatabase::Get().Items())
	{
		const int32 N = GI->Data.ItemCount(It.Id);
		const bool bUsable = It.Kind == TEXT("heal") || It.Kind == TEXT("status") || It.Kind == TEXT("revive") || It.Kind == TEXT("pp")
			|| It.Kind == TEXT("evo") || It.Kind == TEXT("friend");
		if (N <= 0 || !bUsable) continue;
		FLigaChoice C;
		C.Label = FString::Printf(TEXT("%s ×%d"), *It.Name, N);
		C.Detail = It.Desc;
		C.Color = It.Kind == TEXT("heal") ? PcHex(TEXT("2F9E5B")) : It.Kind == TEXT("status") ? PcHex(TEXT("C98A1E"))
			: It.Kind == TEXT("evo") ? PcHex(TEXT("2F8FB0")) : It.Kind == TEXT("friend") ? PcHex(TEXT("D9487A")) : PcHex(TEXT("7A55C9"));
		Opts.Add(C);
		Ids.Add(It.Id);
	}
	FLigaChoice Back;
	Back.Label = TEXT("Назад в меню");
	Opts.Add(Back);
	const FString Title = Ids.Num() ? TEXT("Сумка · что использовать?") : TEXT("Сумка · пусто. Зелья продают в магазине, камни эволюции — на рынке.");
	ShowChoice(Title, Opts, [this, Ids](int32 Pick)
	{
		if (!Ids.IsValidIndex(Pick))
		{
			ToggleMenu();
			return;
		}
		UseItemOn(Ids[Pick]);
	}, true);
}

void ALigaPlayerController::UseItemOn(const FString& ItemId)
{
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	const FLigaItem* Item = FLigaDatabase::Get().Item(ItemId);
	if (!GI || !Item) return;
	const bool bEvoItem = Item->Kind == TEXT("evo");
	const bool bBell = Item->Kind == TEXT("friend");
	TArray<FLigaChoice> Opts;
	for (const FLigaPokemon& Pk : GI->Data.Team)
	{
		FLigaChoice C;
		C.Label = FString::Printf(TEXT("%s  ур. %d"), *LigaRules::DisplayName(Pk), Pk.Level);
		FString Detail = FString::Printf(TEXT("HP %d/%d"), Pk.HP, LigaRules::MaxHp(Pk));
		if (Pk.GetStatus() != EStatus::None) Detail += TEXT(" · ") + LigaTypes::StatusName(Pk.GetStatus());
		if (bEvoItem)
		{
			// A stone only works on the Pokémon it evolves; the others are greyed out.
			const FLigaSpecies* To = FLigaDatabase::Get().Species(LigaRules::ItemEvolution(Pk, ItemId));
			Detail = To ? FString::Printf(TEXT("Может эволюционировать в %s!"), *To->Name) : FString(TEXT("Не подействует"));
			C.bEnabled = To != nullptr;
		}
		else if (bBell)
		{
			Detail = FString::Printf(TEXT("Дружба: %d из 255 — %s"), Pk.Friendship, *LigaRules::FriendshipText(Pk));
			C.bEnabled = Pk.Friendship < 255;
		}
		C.Detail = Detail;
		C.Color = PcHex(TEXT("3B4A7A"));
		Opts.Add(C);
	}
	FLigaChoice Back;
	Back.Label = TEXT("Назад");
	Opts.Add(Back);
	ShowChoice(FString::Printf(TEXT("%s · на кого использовать?"), *Item->Name), Opts, [this, ItemId](int32 Pick)
	{
		ULigaGameInstance* G = ULigaGameInstance::Get(this);
		const FLigaItem* Used = FLigaDatabase::Get().Item(ItemId);
		if (G && Used && G->Data.Team.IsValidIndex(Pick) && G->Data.ItemCount(ItemId) > 0)
		{
			FLigaPokemon& Pk = G->Data.Team[Pick];
			if (Used->Kind == TEXT("evo"))
			{
				const int32 To = LigaRules::ItemEvolution(Pk, ItemId);
				const FLigaSpecies* Target = FLigaDatabase::Get().Species(To);
				if (Target)
				{
					G->Data.Bag.FindOrAdd(ItemId) -= 1;
					const FString Before = LigaRules::DisplayName(Pk);
					LigaRules::Evolve(Pk, To);
					G->Data.MarkCaught(To);
					RememberPosition();
					G->SaveGame();
					ShowDialogue(TEXT(""), {
						FString::Printf(TEXT("%s касается предмета «%s»…"), *Before, *Used->Name),
						FString::Printf(TEXT("Что? %s эволюционирует!"), *Before),
						FString::Printf(TEXT("Поздравляем! %s превратился в %s!"), *Before, *Target->Name),
					}, [this]() { CheckQuests(); });
					return;
				}
				ShowToast(TEXT("Это не подействует."), 3.f);
			}
			else if (Used->Kind == TEXT("friend"))
			{
				LigaRules::AddFriendship(Pk, 50);
				G->Data.Bag.FindOrAdd(ItemId) -= 1;
				const bool bReady = Pk.Friendship >= LigaRules::FriendshipToEvolve;
				ShowToast(FString::Printf(TEXT("%s слушает звон колокольчика. Дружба: %d из 255 — %s.%s"), *LigaRules::DisplayName(Pk), Pk.Friendship,
					*LigaRules::FriendshipText(Pk), bReady ? TEXT(" Некоторые покемоны с такой дружбой эволюционируют при повышении уровня!") : TEXT("")), 5.f);
			}
			else
			{
				FString Msg;
				if (LigaApplyItem(Pk, ItemId, Msg)) G->Data.Bag.FindOrAdd(ItemId) -= 1;
				ShowToast(Msg, 3.f);
			}
		}
		OpenBag();
	}, true);
}

// ——— the Pokédex page of the menu ———

void ALigaPlayerController::OpenPokedex()
{
	if (Mode != ELigaMode::Menu) return;
	MenuPage = 1;
	++UiSerial;
}

void ALigaPlayerController::TurnDexPage(int32 Delta)
{
	constexpr int32 PerPage = 24;
	constexpr int32 Last = 251;  // Kanto and Johto
	const int32 Pages = (Last + PerPage - 1) / PerPage;
	DexPage = (DexPage + Delta + Pages) % Pages;
	++UiSerial;
}

void ALigaPlayerController::SelectDex(int32 Species)
{
	DexSelected = Species;
	++UiSerial;
}

void ALigaPlayerController::CloseMenuPage()
{
	MenuPage = 0;
	++UiSerial;
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
	const bool bTrainerWin = GI && GI->Battle && !GI->Battle->bWild && GI->Battle->Result == ELigaBattleResult::Win;
	const FString Beaten = TrainerNpcId;
	TrainerNpcId.Reset();
	const bool bFished = bFishingBattle;
	bFishingBattle = false;
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
		// Quests count caught Pokémon by type ("catch_type:water"), on a rod, and the ones of Johto.
		const FLigaPokemon& Got = GI->Battle->EnemyMon();
		for (EPokeType T : LigaRules::TypesOf(Got)) LigaQuests::AddCounter(GI->Data, TEXT("catch_type:") + LigaQuests::TypeId(T));
		if (bFished) LigaQuests::AddCounter(GI->Data, TEXT("catch_fishing"));
		if (Got.Species > 151 && Got.Species <= 251) LigaQuests::AddCounter(GI->Data, TEXT("catch_gen2"));
	}
	if (GI && bTrainerWin && !Beaten.IsEmpty())
	{
		GI->Data.SetFlag(TEXT("beat:") + Beaten);
		LigaQuests::AddCounter(GI->Data, TEXT("trainer_win"));
	}
	if (GI) GI->EndBattle();
	SetMode(ELigaMode::Explore);
	CheckQuests();
	if (bTrainerWin && !Beaten.IsEmpty())
	{
		if (const FLigaNpcDef* Def = FLigaLayout::Get().FindNpc(Beaten))
		{
			if (Def->Trainer.After.Num()) ShowDialogue(Def->Name, Def->Trainer.After);
		}
	}
	if (bLost) ShowDialogue(TEXT("Мама"), {TEXT("Ох, ты весь в пыли! Отдохни дома."), TEXT("Твои покемоны снова здоровы.")});
}

// ——— menu ———

void ALigaPlayerController::ToggleMenu()
{
	MenuPage = 0;
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
	case ELigaMode::Fishing:
		FishingConfirm();
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
		if (MenuPage != 0) CloseMenuPage();
		else SetMode(ELigaMode::Explore);
		break;
	case ELigaMode::Fishing:
		StopFishing(TEXT("Вы смотали удочку."));
		break;
	case ELigaMode::Explore:
		MenuPage = 0;
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
