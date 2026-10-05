// Лига 17 — the lead Pokémon walking next to the trainer: R releases it from its Poké Ball and calls it back.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "LigaFollower.generated.h"

class APawn;
class UAnimSequence;
class UPointLightComponent;
class USkeletalMeshComponent;
class UStaticMeshComponent;

UCLASS()
class LIGA17_API ALigaFollower : public AActor
{
	GENERATED_BODY()

public:
	ALigaFollower();

	virtual void Tick(float DeltaSeconds) override;

	/** Shows the Pokémon's 3D model next to the trainer; false when the species has no model. */
	bool Setup(APawn* InTrainer, int32 InSpecies, bool bInShiny);
	/** Back into the ball: shrinks with a flash, then the actor is destroyed. */
	void Recall();

	int32 Species = 0;
	bool bShiny = false;

private:
	UPROPERTY() TObjectPtr<USceneComponent> Root;
	UPROPERTY() TObjectPtr<USceneComponent> Body;
	UPROPERTY() TObjectPtr<USkeletalMeshComponent> Skel;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> Static;
	UPROPERTY() TObjectPtr<UPointLightComponent> Flash;
	UPROPERTY() TObjectPtr<UAnimSequence> IdleAnim;
	UPROPERTY() TObjectPtr<UAnimSequence> WalkAnim;

	TWeakObjectPtr<APawn> Trainer;
	float ModelScale = 1.f;   // model units -> the species' height in cm
	float ModelLift = 0.f;    // model units from the model's origin down to its feet
	float Grow = 0.f;         // 0..1 coming out of the ball, back to 0 when recalled
	float FlashLevel = 0.f;
	bool bSkeletal = false;
	bool bWalking = false;
	bool bRecalling = false;
	FVector Velocity = FVector::ZeroVector;

	void PlayClip(bool bWalk);
};
