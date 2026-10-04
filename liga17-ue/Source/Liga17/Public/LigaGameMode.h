// Лига 17 — game mode: our pawn, controller and HUD; makes sure the world builder exists.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "LigaGameMode.generated.h"

UCLASS()
class LIGA17_API ALigaGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	ALigaGameMode();
	virtual void StartPlay() override;
};
