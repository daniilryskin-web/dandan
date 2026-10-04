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
};
