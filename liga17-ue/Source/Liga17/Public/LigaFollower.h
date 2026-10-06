// Лига 17 — a Pokémon walking in the overworld: the lead Pokémon next to the trainer (R releases it from its Poké Ball
// and calls it back), or one of the Pokémon living in town, strolling around its spot (SetupAmbient).
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "LigaInteractable.h"
#include "LigaFollower.generated.h"

class APawn;
class UAnimSequence;
class UPointLightComponent;
class USkeletalMeshComponent;
class UStaticMeshComponent;

UCLASS()
class LIGA17_API ALigaFollower : public AActor, public ILigaInteractable
{
	GENERATED_BODY()

public:
	ALigaFollower();

	virtual void Tick(float DeltaSeconds) override;

	/** Shows the Pokémon's 3D model next to the trainer; false when the species has no model. */
	bool Setup(APawn* InTrainer, int32 InSpecies, bool bInShiny);
	/** A Pokémon living in town: wanders within Radius (cm) of Home. With a quest it shows only while that quest needs
	 *  it (and, without a 3D model, as a glowing ball so the quest can still be done). */
	bool SetupAmbient(int32 InSpecies, const FVector& InHome, float InRadius, const FString& InQuest);
	/** Back into the ball: shrinks with a flash, then the actor is destroyed. */
	void Recall();

	virtual FString GetPromptText() const override;
	virtual FString GetDisplayName() const override;
	virtual void Interact(ALigaPlayerController* PC) override;
	virtual bool CanInteract() const override;

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

	// ——— town Pokémon ———
	bool bAmbient = false;
	FVector Home = FVector::ZeroVector;
	float Radius = 300.f;
	FVector WanderGoal = FVector::ZeroVector;
	float WanderWait = 0.f;
	FString Quest;
	bool bQuestShown = false;
	float QuestCheck = 0.f;
	float PetTimer = 0.f;

	void PlayClip(bool bWalk);
	bool LoadModel(bool bAllowPlaceholder);
	void TickAmbient(float Dt);
	bool QuestWantsMe() const;
	float GroundZ(const FVector& At, float From) const;
};
