// Лига 17 — the player's trainer: third-person camera, Enhanced Input created in code, interaction and wild encounters.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "InputActionValue.h"
#include "LigaCharacter.generated.h"

class UCameraComponent;
class UInputAction;
class UInputMappingContext;
class USpringArmComponent;

/** Sets up the mannequin (Third Person content) and, if VRM4U and a VRoid model are present, the anime model driven by it. */
namespace LigaVisuals
{
	LIGA17_API void SetupBody(ACharacter* Character, USkeletalMeshComponent* VrmMesh, const FString& VrmAssetList);
}

UCLASS()
class LIGA17_API ALigaCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	ALigaCharacter();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;
	virtual void PawnClientRestart() override;

	UPROPERTY(VisibleAnywhere, Category = "Liga")
	TObjectPtr<USpringArmComponent> CameraBoom;

	UPROPERTY(VisibleAnywhere, Category = "Liga")
	TObjectPtr<UCameraComponent> FollowCamera;

	UPROPERTY(VisibleAnywhere, Category = "Liga")
	TObjectPtr<USkeletalMeshComponent> VrmMesh;

	/** Interactable actor in front of the player (NPC, door), if any. */
	TWeakObjectPtr<AActor> Focus;

	/** Distance walked in tall grass since the last encounter roll (cm). */
	float GrassWalk = 0.f;

private:
	UPROPERTY() TObjectPtr<UInputMappingContext> Mapping;
	UPROPERTY() TObjectPtr<UInputAction> MoveAction;
	UPROPERTY() TObjectPtr<UInputAction> LookAction;
	UPROPERTY() TObjectPtr<UInputAction> JumpAction;
	UPROPERTY() TObjectPtr<UInputAction> RunAction;
	UPROPERTY() TObjectPtr<UInputAction> InteractAction;
	UPROPERTY() TObjectPtr<UInputAction> BackAction;
	UPROPERTY() TObjectPtr<UInputAction> MenuAction;
	UPROPERTY() TObjectPtr<UInputAction> ZoomAction;
	UPROPERTY() TObjectPtr<UInputAction> NumberAction;

	float FocusTimer = 0.f;
	float ZoomGoal = 430.f;
	FVector LastPos = FVector::ZeroVector;

	void BuildInput();
	void OnMove(const FInputActionValue& V);
	void OnLook(const FInputActionValue& V);
	void OnJump();
	void OnRunStart();
	void OnRunStop();
	void OnInteract();
	void OnBack();
	void OnMenu();
	void OnZoom(const FInputActionValue& V);
	void OnNumber(const FInputActionValue& V);
	void UpdateFocus();
	void UpdateEncounters(float Dt);
	class ALigaPlayerController* LigaPC() const;
};
