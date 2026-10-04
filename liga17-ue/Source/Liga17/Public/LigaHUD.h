// Лига 17 — on-screen interface (Slate, built entirely in code): overworld HUD, dialogue, choices, battle UI, menu.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "LigaHUD.generated.h"

class SLigaHUDWidget;

UCLASS()
class LIGA17_API ALigaHUD : public AHUD
{
	GENERATED_BODY()

public:
	ALigaHUD();
	virtual void Tick(float DeltaSeconds) override;
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type Reason) override;
	/** Floating damage numbers over the battle billboards. */
	virtual void DrawHUD() override;

private:
	TSharedPtr<SLigaHUDWidget> Widget;
	TSharedPtr<class SWidget> Container;
};
