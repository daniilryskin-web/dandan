// Лига 17 — things the player can talk to or use (NPCs, doors, signs).
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "UObject/Interface.h"
#include "LigaInteractable.generated.h"

class ALigaPlayerController;
class USphereComponent;

UINTERFACE(MinimalAPI)
class ULigaInteractable : public UInterface
{
	GENERATED_BODY()
};

class LIGA17_API ILigaInteractable
{
	GENERATED_BODY()

public:
	/** Short prompt, e.g. "Поговорить". */
	virtual FString GetPromptText() const = 0;
	virtual FString GetDisplayName() const = 0;
	virtual void Interact(ALigaPlayerController* PC) = 0;
	/** False while it should be ignored (hidden, busy). */
	virtual bool CanInteract() const { return true; }
};

UENUM()
enum class ELigaDoorKind : uint8
{
	Home,
	Lab,
	House,
	Sign,
	/** Leads into a room or back outside (Target). */
	Portal,
	/** The Poké Center computer with the Pokémon storage. */
	Pc,
};

/** An invisible interaction point placed at a building's door. */
UCLASS()
class LIGA17_API ALigaDoor : public AActor, public ILigaInteractable
{
	GENERATED_BODY()

public:
	ALigaDoor();

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USphereComponent> Trigger;

	UPROPERTY(EditAnywhere)
	ELigaDoorKind Kind = ELigaDoorKind::House;

	UPROPERTY(EditAnywhere)
	FString Title;

	UPROPERTY(EditAnywhere)
	TArray<FString> Lines;

	/** Portal: where the player appears (world) and which way they face. */
	UPROPERTY(EditAnywhere)
	FVector Target = FVector::ZeroVector;

	UPROPERTY(EditAnywhere)
	float TargetYaw = 0.f;

	/** Portal: used by simply walking into it. */
	UPROPERTY(EditAnywhere)
	bool bWalkIn = false;

	/** Portal back outside (prompt "Выйти"). */
	UPROPERTY(EditAnywhere)
	bool bExit = false;

	virtual FString GetPromptText() const override;
	virtual FString GetDisplayName() const override { return Title; }
	virtual void Interact(ALigaPlayerController* PC) override;
};
