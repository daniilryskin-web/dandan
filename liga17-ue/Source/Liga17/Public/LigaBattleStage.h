// Лига 17 — battle presentation in the overworld: two Pokémon billboards (HOME renders), camera, effects,
// and a queue that plays the engine's battle events one after another.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "LigaBattle.h"
#include "LigaBattleStage.generated.h"

class UAnimSequence;
class UCameraComponent;
class UMaterialInstanceDynamic;
class USkeletalMeshComponent;
class UProceduralMeshComponent;
class UStaticMeshComponent;
class UTexture2D;

USTRUCT()
struct FLigaBillboard
{
	GENERATED_BODY()

	UPROPERTY() TObjectPtr<UProceduralMeshComponent> Mesh;
	UPROPERTY() TObjectPtr<UMaterialInstanceDynamic> Mat;
	// 3D model (when imported for this species); the picture quad is hidden then.
	UPROPERTY() TObjectPtr<USkeletalMeshComponent> Skel;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> Static;
	UPROPERTY() TObjectPtr<UAnimSequence> IdleAnim;
	UPROPERTY() TObjectPtr<UAnimSequence> AttackAnim;
	UPROPERTY() TObjectPtr<UAnimSequence> FaintAnim;
	bool bModel = false;
	bool bSkeletal = false;
	float ModelScale = 1.f;
	float ModelLift = 0.f;
	/** Horizontal centre of the model's bounds in its own space (models are often not centred on their origin). */
	FVector ModelCenter = FVector::ZeroVector;
	FVector Home = FVector::ZeroVector;
	float Height = 100.f;
	int32 Species = 0;
	int32 Uid = 0;
	bool bShiny = false;
	bool bHasTexture = false;
	/** Current animation: idle, attack, hit, faint, appear, capture, hidden. */
	FName Anim = TEXT("idle");
	float AnimTime = 0.f;
};

struct FLigaPopup
{
	FString Text;
	FLinearColor Color = FLinearColor::White;
	FVector World = FVector::ZeroVector;
	float Age = 0.f;
};

UCLASS()
class LIGA17_API ALigaBattleStage : public AActor
{
	GENERATED_BODY()

public:
	ALigaBattleStage();

	/** Places the arena in front of the player and blends the camera in. */
	void Begin(APawn* PlayerPawn);
	/** Queues events from the engine; the UI waits until IsBusy() is false. */
	void Play(const TArray<FLigaBattleEvent>& Events);
	void SkipText() { bFast = true; }
	bool IsBusy() const { return Queue.Num() > 0 || Wait > 0.f || bBallActive; }
	void Finish();

	virtual void Tick(float DeltaSeconds) override;

	// ——— state for the HUD (what is currently shown, not the engine's state) ———
	FString Message;
	int32 ShownHp[2] = {0, 0};
	int32 TargetHp[2] = {0, 0};
	int32 MaxHp[2] = {1, 1};
	EStatus ShownStatus[2] = {EStatus::None, EStatus::None};
	int32 ShownUid[2] = {0, 0};
	TArray<FLigaPopup> Popups;
	bool bIntro = true;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UCameraComponent> Camera;

private:
	UPROPERTY() TObjectPtr<USceneComponent> Root;
	UPROPERTY() FLigaBillboard Mons[2];
	UPROPERTY() TObjectPtr<UStaticMeshComponent> Ball;
	UPROPERTY() TObjectPtr<UMaterialInstanceDynamic> BallMat;
	UPROPERTY() TObjectPtr<APawn> Trainer;

	TArray<FLigaBattleEvent> Queue;
	float Wait = 0.f;
	bool bFast = false;
	FVector Forward = FVector::ForwardVector;
	FVector Right = FVector::RightVector;
	FVector Center = FVector::ZeroVector;
	FVector CamGoal = FVector::ZeroVector;
	FVector LookGoal = FVector::ZeroVector;
	FVector CamPos = FVector::ZeroVector;
	FVector LookPos = FVector::ZeroVector;
	/** 0 idle, 1 look at enemy (player attacks), 2 look at player (enemy attacks). */
	int32 Focus = 0;
	float Shake = 0.f;
	float Time = 0.f;

	bool bBallActive = false;
	float BallTime = 0.f;
	int32 BallShakes = 0;
	bool bBallCaught = false;

	FVector GroundAt(const FVector& P) const;
	void SetupMon(int32 Side, const FLigaPokemon& P, const FVector& Where);
	void SetMonTexture(int32 Side, UTexture2D* Tex);
	bool SetupModel(int32 Side, const FLigaPokemon& P);
	void Animate(int32 Side, FName Anim);
	void UpdateMon(int32 Side, float Dt);
	void UpdateCamera(float Dt);
	void UpdateBall(float Dt);
	void NextEvent();
	void AddPopup(int32 Side, const FString& Text, const FLinearColor& Color);
	float Speed() const { return bFast ? 4.f : 1.f; }
};
