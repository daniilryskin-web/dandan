// Лига 17 — battle presentation in the overworld: two Pokémon billboards (HOME renders), camera, effects,
// and a queue that plays the engine's battle events one after another.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "LigaBattle.h"
#include "LigaBattleStage.generated.h"

class ALigaWorldBuilder;

class ALigaBattleFx;
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
	UPROPERTY() TObjectPtr<UAnimSequence> PoseAnim;
	bool bPosed = false;
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
	virtual void Destroyed() override;

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
	/** The Poké Ball, built in code (BuildBall): this pivot flies, spins and wobbles; the white lower half carries the
	 *  button, the red lid opens on a hinge at the back. */
	UPROPERTY() TObjectPtr<USceneComponent> Ball;
	UPROPERTY() TObjectPtr<UProceduralMeshComponent> BallLower;
	UPROPERTY() TObjectPtr<USceneComponent> BallHinge;
	UPROPERTY() TObjectPtr<UProceduralMeshComponent> BallLid;
	UPROPERTY() TObjectPtr<UMaterialInstanceDynamic> BallButton;
	UPROPERTY() TArray<TObjectPtr<UMaterialInstanceDynamic>> BallMats;
	UPROPERTY() TObjectPtr<APawn> Trainer;
	/** Move and status effects. */
	UPROPERTY() TObjectPtr<ALigaBattleFx> Fx;

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

	/** Seconds until the next "Z" over a sleeping Pokémon. */
	float SleepTimer[2] = {0.f, 0.f};
	/** Sea surface height (world): battles at the shore keep water Pokémon on the water. */
	float SeaZ = -1.0e9f;
	/** For the water level of ponds (Pokémon fished from a pond float on it). */
	TWeakObjectPtr<ALigaWorldBuilder> Builder;

	bool bBallActive = false;
	float BallTime = 0.f;
	int32 BallShakes = 0;
	bool bBallCaught = false;
	float BallTrailClock = 0.f;
	/** Where the Pokémon is drawn to while it is caught (the open ball). */
	FVector CaptureTo = FVector::ZeroVector;

	FVector GroundAt(const FVector& P) const;
	void SetupMon(int32 Side, const FLigaPokemon& P, const FVector& Where);
	void SetMonTexture(int32 Side, UTexture2D* Tex);
	bool SetupModel(int32 Side, const FLigaPokemon& P);
	void Animate(int32 Side, FName Anim);
	void UpdateMon(int32 Side, float Dt);
	void UpdateCamera(float Dt);
	void UpdateBall(float Dt);
	void BuildBall();
	void NextEvent();
	void AddPopup(int32 Side, const FString& Text, const FLinearColor& Color);
	/** Height of what is drawn for a side (the model is 80% of the picture size). */
	float FxHeight(int32 Side) const;
	void UpdateAura(int32 Side);
	float Speed() const { return bFast ? 4.f : 1.f; }
};
