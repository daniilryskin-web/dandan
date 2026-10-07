#include "LigaNPC.h"

#include "Components/CapsuleComponent.h"
#include "Components/WidgetComponent.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "Kismet/GameplayStatics.h"
#include "LigaAssets.h"
#include "LigaCharacter.h"
#include "LigaGameInstance.h"
#include "LigaPlayerController.h"
#include "LigaQuests.h"
#include "Widgets/SBoxPanel.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Text/STextBlock.h"

ALigaNPC::ALigaNPC()
{
	PrimaryActorTick.bCanEverTick = true;
	GetCapsuleComponent()->InitCapsuleSize(34.f, 88.f);
	GetCharacterMovement()->MaxWalkSpeed = 180.f;
	// NPCs have no controller: let the movement component run anyway, and turn them the way they walk.
	GetCharacterMovement()->bRunPhysicsWithNoController = true;
	GetCharacterMovement()->bOrientRotationToMovement = true;
	GetCharacterMovement()->RotationRate = FRotator(0.f, 300.f, 0.f);
	GetCharacterMovement()->BrakingDecelerationWalking = 900.f;
	bUseControllerRotationYaw = false;
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

void ALigaNPC::SetTrainer(float InSightCm)
{
	bTrainer = true;
	SightCm = FMath::Max(0.f, InSightCm);
}

bool ALigaNPC::WantsBattle() const
{
	const ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	return bTrainer && GI && !GI->Data.HasFlag(TEXT("beat:") + Id);
}

void ALigaNPC::LookForChallengers(APawn* Player, float Dt)
{
	ChallengeCooldown = FMath::Max(0.f, ChallengeCooldown - Dt);
	if (!Player || SightCm <= 0.f || ChallengeCooldown > 0.f || !WantsBattle()) return;
	ALigaPlayerController* PC = Cast<ALigaPlayerController>(Player->GetController());
	const ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!PC || !PC->IsExploring() || !GI || !GI->HasStarter() || GI->Data.FirstAliveIndex() == INDEX_NONE) return;
	const FVector To = Player->GetActorLocation() - GetActorLocation();
	if (To.Size2D() > SightCm || FMath::Abs(To.Z) > 250.f) return;
	// Seen: in front of the trainer (a cone of about 50 degrees each way).
	if (FVector::DotProduct(To.GetSafeNormal2D(), GetActorForwardVector().GetSafeNormal2D()) < 0.64f) return;
	ChallengeCooldown = 8.f;
	Attend(6.f);
	PC->ChallengeTrainer(this);
}

void ALigaNPC::SetRoute(const TArray<FVector>& Points, bool bInLoop, float SpeedCm, float PauseSeconds)
{
	Route = Points;
	bLoop = bInLoop;
	PauseTime = FMath::Max(0.f, PauseSeconds);
	RouteIndex = Route.Num() > 1 ? 1 : 0;
	RouteStep = 1;
	GetCharacterMovement()->MaxWalkSpeed = FMath::Clamp(SpeedCm, 60.f, 600.f);
}

void ALigaNPC::BeginPlay()
{
	Super::BeginPlay();
	HomeYaw = GetActorRotation().Yaw;
	LastPos = GetActorLocation();
	// The cast is keyed by NPC id; the look ("man", "girl"…) is the fallback for hand-added models.
	const FLigaAssets& A = FLigaAssets::Get();
	const FString Key = A.NpcVrm.Contains(Id) ? Id : Look;
	const FString* Vrm = A.NpcVrm.Find(Key);
	const FString* Rtg = A.NpcRtg.Find(Key);
	LigaVisuals::SetupBody(this, VrmMesh, Vrm ? *Vrm : FString(), Rtg ? *Rtg : FString());
	if (const ULigaGameInstance* GI = ULigaGameInstance::Get(this)) Marker = LigaQuests::MarkerFor(GI->Data, Id);
	BuildNameTag();
}

void ALigaNPC::BuildNameTag()
{
	// "!" — has a quest for you, "?" — waiting for your report, "…" — a quest of theirs is in progress.
	const FLinearColor MarkColor = Marker == TEXT("?") ? FLinearColor(0.15f, 0.75f, 0.35f) : Marker == TEXT("!") ? FLinearColor(1.f, 0.62f, 0.05f)
		: Marker == TEXT("VS") ? FLinearColor(0.85f, 0.16f, 0.2f) : FLinearColor(0.45f, 0.5f, 0.62f);
	TSharedRef<SHorizontalBox> Row = SNew(SHorizontalBox);
	if (!Marker.IsEmpty())
	{
		Row->AddSlot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 6.f, 0.f)
		[
			SNew(SBorder)
			.BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
			.BorderBackgroundColor(MarkColor)
			.Padding(FMargin(7.f, 0.f))
			[
				SNew(STextBlock)
				.Text(FText::FromString(Marker))
				.Font(FCoreStyle::GetDefaultFontStyle("Bold", 15))
				.ColorAndOpacity(FLinearColor::White)
			]
		];
	}
	Row->AddSlot().AutoWidth().VAlign(VAlign_Center)
	[
		SNew(STextBlock)
		.Text(FText::FromString(DisplayName))
		.Font(FCoreStyle::GetDefaultFontStyle("Bold", 12))
		.ColorAndOpacity(FLinearColor(0.08f, 0.1f, 0.18f))
	];
	NameTag->SetSlateWidget(
		SNew(SBorder)
		.BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
		.BorderBackgroundColor(FLinearColor(1.f, 1.f, 1.f, 0.88f))
		.Padding(FMargin(8.f, 3.f, 10.f, 3.f))
		[Row]);
}

void ALigaNPC::NextWaypoint()
{
	const int32 N = Route.Num();
	if (N < 2) return;
	if (bLoop)
	{
		RouteIndex = (RouteIndex + 1) % N;
		return;
	}
	if (RouteIndex + RouteStep >= N || RouteIndex + RouteStep < 0) RouteStep = -RouteStep;
	RouteIndex += RouteStep;
}

void ALigaNPC::Walk(float Dt)
{
	if (PauseLeft > 0.f)
	{
		PauseLeft -= Dt;
		return;
	}
	FVector To = Route[RouteIndex] - GetActorLocation();
	To.Z = 0.f;
	if (To.Size() < 70.f)
	{
		NextWaypoint();
		PauseLeft = PauseTime;
		StuckTime = 0.f;
		return;
	}
	AddMovementInput(To.GetSafeNormal(), 1.f);
	// Bumped into something (the player, a bench): after a while try the next point instead.
	const float Moved = FVector::Dist2D(GetActorLocation(), LastPos);
	StuckTime = Moved < GetCharacterMovement()->MaxWalkSpeed * Dt * 0.2f ? StuckTime + Dt : FMath::Max(0.f, StuckTime - Dt);
	if (StuckTime > 2.5f)
	{
		StuckTime = 0.f;
		NextWaypoint();
	}
}

void ALigaNPC::Tick(float Dt)
{
	Super::Tick(Dt);
	APawn* Player = UGameplayStatics::GetPlayerPawn(this, 0);
	bool bAttend = TalkTimer > 0.f;
	FVector ToPlayer = FVector::ZeroVector;
	if (Player)
	{
		ToPlayer = Player->GetActorLocation() - GetActorLocation();
		const float Dist = ToPlayer.Size2D();
		bAttend |= Dist < 320.f && FMath::Abs(ToPlayer.Z) < 300.f;
		NameTag->SetVisibility(Dist < 1500.f && FMath::Abs(ToPlayer.Z) < 600.f);
	}
	TalkTimer = FMath::Max(0.f, TalkTimer - Dt);
	if (Route.Num() >= 2 && !bAttend)
	{
		Walk(Dt);  // the movement component turns the NPC the way it walks
	}
	else
	{
		// Face the player while talking or when close; otherwise stand as placed (or as the walk ended).
		const float GoalYaw = bAttend ? ToPlayer.Rotation().Yaw : (Route.Num() >= 2 ? GetActorRotation().Yaw : HomeYaw);
		FRotator R = GetActorRotation();
		R.Yaw = FMath::FixedTurn(R.Yaw, GoalYaw, 240.f * Dt);
		SetActorRotation(R);
	}
	LastPos = GetActorLocation();
	if (bTrainer) LookForChallengers(Player, Dt);

	MarkerCheck -= Dt;
	if (MarkerCheck <= 0.f)
	{
		MarkerCheck = 0.5f;
		if (const ULigaGameInstance* GI = ULigaGameInstance::Get(this))
		{
			FString Now = LigaQuests::MarkerFor(GI->Data, Id);
			if (Now.IsEmpty() && GI->HasStarter() && WantsBattle()) Now = TEXT("VS");
			if (Now != Marker)
			{
				Marker = Now;
				BuildNameTag();
			}
		}
	}
}

void ALigaNPC::Interact(ALigaPlayerController* PC)
{
	TalkTimer = 4.f;
	if (PC) PC->TalkToNpc(this);
}
