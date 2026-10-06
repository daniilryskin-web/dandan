// Лига 17 — a townsperson with a name tag and dialogue.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "LigaInteractable.h"
#include "LigaNPC.generated.h"

class UWidgetComponent;

UCLASS()
class LIGA17_API ALigaNPC : public ACharacter, public ILigaInteractable
{
	GENERATED_BODY()

public:
	ALigaNPC();

	void Configure(const FString& InId, const FString& InName, const FString& InLook, const TArray<FString>& InLines);
	/** Walks along these points (world space); loops or goes back and forth, pausing at each one. */
	void SetRoute(const TArray<FVector>& Points, bool bInLoop, float SpeedCm, float PauseSeconds);
	/** Stops walking for a while and faces the player (while talking). */
	void Attend(float Seconds) { TalkTimer = FMath::Max(TalkTimer, Seconds); }

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	virtual FString GetPromptText() const override { return TEXT("Поговорить"); }
	virtual FString GetDisplayName() const override { return DisplayName; }
	virtual void Interact(ALigaPlayerController* PC) override;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USkeletalMeshComponent> VrmMesh;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UWidgetComponent> NameTag;

	FString Id;
	FString DisplayName;
	FString Look;
	TArray<FString> Lines;

private:
	float HomeYaw = 0.f;
	float TalkTimer = 0.f;

	TArray<FVector> Route;
	bool bLoop = true;
	int32 RouteIndex = 0;
	int32 RouteStep = 1;
	float PauseTime = 2.f;
	float PauseLeft = 0.f;
	float StuckTime = 0.f;
	FVector LastPos = FVector::ZeroVector;

	/** Quest marker currently shown on the name tag ("!", "?", "…" or empty). */
	FString Marker;
	float MarkerCheck = 0.f;

	void BuildNameTag();
	void Walk(float Dt);
	void NextWaypoint();
};
