#include "LigaInteractable.h"

#include "Components/SphereComponent.h"
#include "LigaGameInstance.h"
#include "LigaPlayerController.h"

ALigaDoor::ALigaDoor()
{
	Trigger = CreateDefaultSubobject<USphereComponent>(TEXT("Trigger"));
	Trigger->InitSphereRadius(140.f);
	Trigger->SetCollisionProfileName(TEXT("OverlapAllDynamic"));
	Trigger->SetGenerateOverlapEvents(true);
	RootComponent = Trigger;
}

FString ALigaDoor::GetPromptText() const
{
	switch (Kind)
	{
	case ELigaDoorKind::Home: return TEXT("Войти домой");
	case ELigaDoorKind::Lab: return TEXT("Войти в лабораторию");
	case ELigaDoorKind::Sign: return TEXT("Прочитать");
	case ELigaDoorKind::Portal: return bExit ? TEXT("Выйти") : TEXT("Войти");
	case ELigaDoorKind::Pc: return TEXT("Включить");
	case ELigaDoorKind::Train: return TEXT("Сесть в поезд");
	case ELigaDoorKind::Fishing: return TEXT("Закинуть удочку");
	default: return TEXT("Постучать");
	}
}

void ALigaDoor::Interact(ALigaPlayerController* PC)
{
	if (!PC) return;
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	switch (Kind)
	{
	case ELigaDoorKind::Home:
		if (GI && GI->HasStarter())
		{
			GI->HealTeam();
			GI->SaveGame();
			PC->ShowDialogue(TEXT("Мама"), {TEXT("С возвращением! Отдохни немного."), TEXT("Твои покемоны полностью здоровы. Игра сохранена.")});
		}
		else
		{
			PC->ShowDialogue(TEXT("Мама"), {TEXT("Профессор Оук ждёт тебя в своей лаборатории!"), TEXT("Она к югу от площади.")});
		}
		break;
	case ELigaDoorKind::Lab:
		PC->TalkToOak();
		break;
	case ELigaDoorKind::Portal:
		PC->TravelTo(Target, TargetYaw);
		break;
	case ELigaDoorKind::Pc:
		PC->OpenStorage();
		break;
	case ELigaDoorKind::Train:
		PC->RideTrain(Title, Target, TargetYaw);
		break;
	case ELigaDoorKind::Fishing:
		PC->StartFishing(SpotId, Title);
		break;
	default:
		PC->ShowDialogue(Title, Lines.Num() ? Lines : TArray<FString>{TEXT("Никто не отвечает...")});
		break;
	}
}
