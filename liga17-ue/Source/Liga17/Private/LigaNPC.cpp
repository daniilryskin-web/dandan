#include "LigaNPC.h"

#include "Components/CapsuleComponent.h"
#include "Components/WidgetComponent.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "Kismet/GameplayStatics.h"
#include "LigaAssets.h"
#include "LigaCharacter.h"
#include "LigaPlayerController.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Text/STextBlock.h"

ALigaNPC::ALigaNPC()
{
	PrimaryActorTick.bCanEverTick = true;
	GetCapsuleComponent()->InitCapsuleSize(34.f, 88.f);
	GetCharacterMovement()->MaxWalkSpeed = 180.f;
	GetMesh()->SetRelativeLocationAndRotation(FVector(0.f, 0.f, -90.f), FRotator(0.f, -90.f, 0.f));
	VrmMesh = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("VrmMesh"));
	VrmMesh->SetupAttachment(GetMesh());
	VrmMesh->SetVisibility(false);
	VrmMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	NameTag = CreateDefaultSubobject<UWidgetComponent>(TEXT("NameTag"));
	NameTag->SetupAttachment(RootComponent);
	NameTag->SetRelativeLocation(FVector(0.f, 0.f, 125.f));
	NameTag->SetWidgetSpace(EWidgetSpace::Screen);
	NameTag->SetDrawAtDesiredSize(true);
	NameTag->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	AutoPossessAI = EAutoPossessAI::Disabled;
}

void ALigaNPC::Configure(const FString& InId, const FString& InName, const FString& InLook, const TArray<FString>& InLines)
{
	Id = InId;
	DisplayName = InName;
	Look = InLook;
	Lines = InLines;
}

void ALigaNPC::BeginPlay()
{
	Super::BeginPlay();
	HomeYaw = GetActorRotation().Yaw;
	// The cast is keyed by NPC id; the look ("man", "girl"…) is the fallback for hand-added models.
	const FLigaAssets& A = FLigaAssets::Get();
	const FString Key = A.NpcVrm.Contains(Id) ? Id : Look;
	const FString* Vrm = A.NpcVrm.Find(Key);
	const FString* Rtg = A.NpcRtg.Find(Key);
	LigaVisuals::SetupBody(this, VrmMesh, Vrm ? *Vrm : FString(), Rtg ? *Rtg : FString());
	NameTag->SetSlateWidget(
		SNew(SBorder)
		.BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
		.BorderBackgroundColor(FLinearColor(1.f, 1.f, 1.f, 0.88f))
		.Padding(FMargin(10.f, 3.f))
		[
			SNew(STextBlock)
			.Text(FText::FromString(DisplayName))
			.Font(FCoreStyle::GetDefaultFontStyle("Bold", 12))
			.ColorAndOpacity(FLinearColor(0.08f, 0.1f, 0.18f))
		]);
}

void ALigaNPC::Tick(float Dt)
{
	Super::Tick(Dt);
	// Look at the player while talking / when close, otherwise return to the original direction.
	APawn* Player = UGameplayStatics::GetPlayerPawn(this, 0);
	float GoalYaw = HomeYaw;
	if (Player)
	{
		const FVector D = Player->GetActorLocation() - GetActorLocation();
		if (D.Size2D() < 320.f || TalkTimer > 0.f) GoalYaw = D.Rotation().Yaw;
		const bool bNear = D.Size2D() < 1500.f;
		NameTag->SetVisibility(bNear);
	}
	TalkTimer = FMath::Max(0.f, TalkTimer - Dt);
	FRotator R = GetActorRotation();
	R.Yaw = FMath::FixedTurn(R.Yaw, GoalYaw, 240.f * Dt);
	SetActorRotation(R);
}

void ALigaNPC::Interact(ALigaPlayerController* PC)
{
	TalkTimer = 4.f;
	if (!PC) return;
	if (Id == TEXT("oak"))
	{
		PC->TalkToOak();
		return;
	}
	if (Id == TEXT("mom"))
	{
		PC->TalkToMom();
		return;
	}
	PC->ShowDialogue(DisplayName, Lines);
}
