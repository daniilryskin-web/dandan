#include "LigaGameMode.h"

#include "EngineUtils.h"
#include "LigaCharacter.h"
#include "LigaHUD.h"
#include "LigaPlayerController.h"
#include "LigaWorldBuilder.h"

ALigaGameMode::ALigaGameMode()
{
	DefaultPawnClass = ALigaCharacter::StaticClass();
	PlayerControllerClass = ALigaPlayerController::StaticClass();
	HUDClass = ALigaHUD::StaticClass();
}

void ALigaGameMode::StartPlay()
{
	bool bHasBuilder = false;
	for (TActorIterator<ALigaWorldBuilder> It(GetWorld()); It; ++It)
	{
		bHasBuilder = true;
		break;
	}
	if (!bHasBuilder)
	{
		FActorSpawnParameters P;
		P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		GetWorld()->SpawnActor<ALigaWorldBuilder>(FVector::ZeroVector, FRotator::ZeroRotator, P);
	}
	Super::StartPlay();
}
