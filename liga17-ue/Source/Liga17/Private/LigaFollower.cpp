#include "LigaFollower.h"

#include "Animation/AnimSequence.h"
#include "Components/PointLightComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "LigaAssets.h"
#include "LigaData.h"
#include "LigaPlayerController.h"

ALigaFollower::ALigaFollower()
{
	PrimaryActorTick.bCanEverTick = true;
	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	Root->SetMobility(EComponentMobility::Movable);
	RootComponent = Root;
	Body = CreateDefaultSubobject<USceneComponent>(TEXT("Body"));
	Body->SetupAttachment(Root);
	// Imported glTF models face +Y in their own space; the actor walks along +X.
	Skel = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("Skel"));
	Skel->SetupAttachment(Body);
	Skel->SetRelativeRotation(FRotator(0.f, -90.f, 0.f));
	Skel->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Static = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Static"));
	Static->SetupAttachment(Body);
	Static->SetMobility(EComponentMobility::Movable);
	Static->SetRelativeRotation(FRotator(0.f, -90.f, 0.f));
	Static->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Flash = CreateDefaultSubobject<UPointLightComponent>(TEXT("Flash"));
	Flash->SetupAttachment(Root);
	Flash->SetMobility(EComponentMobility::Movable);
	Flash->SetRelativeLocation(FVector(0.f, 0.f, 50.f));
	Flash->SetIntensity(0.f);
	Flash->SetAttenuationRadius(400.f);
	Flash->SetLightColor(FLinearColor(1.f, 0.93f, 0.8f));
	Flash->SetCastShadows(false);
}

bool ALigaFollower::Setup(APawn* InTrainer, int32 InSpecies, bool bInShiny)
{
	Trainer = InTrainer;
	Species = InSpecies;
	bShiny = bInShiny;
	const FLigaModel3D* Def = FLigaAssets::Get().FindModel3D(Species, bShiny);
	if (!Def || !InTrainer) return false;
	UObject* Obj = LoadObject<UObject>(nullptr, *Def->Mesh, nullptr, LOAD_NoWarn | LOAD_Quiet);
	FBoxSphereBounds B(ForceInit);
	if (USkeletalMesh* SK = Cast<USkeletalMesh>(Obj))
	{
		Skel->SetSkeletalMesh(SK);
		Skel->SetAnimationMode(EAnimationMode::AnimationSingleNode);
		auto LoadAnim = [](const FString& Path) { return Path.IsEmpty() ? nullptr : LoadObject<UAnimSequence>(nullptr, *Path, nullptr, LOAD_NoWarn | LOAD_Quiet); };
		IdleAnim = LoadAnim(Def->Idle);
		if (!IdleAnim) IdleAnim = LoadAnim(Def->Pose);
		WalkAnim = LoadAnim(Def->Walk);
		Static->SetVisibility(false);
		B = SK->GetBounds();
		bSkeletal = true;
		PlayClip(false);
	}
	else if (UStaticMesh* SM = Cast<UStaticMesh>(Obj))
	{
		Static->SetStaticMesh(SM);
		Skel->SetVisibility(false);
		B = SM->GetBounds();
	}
	else
	{
		return false;
	}
	// The size of the real Pokémon (species height, metres), within what looks good next to a 1.8 m trainer.
	const FLigaSpecies* S = FLigaDatabase::Get().Species(Species);
	const float TargetCm = FMath::Clamp((S ? S->Height : 0.6f) * 100.f, 30.f, 200.f);
	ModelScale = TargetCm / FMath::Max(1.f, B.BoxExtent.Z * 2.f);
	ModelLift = -(B.Origin.Z - B.BoxExtent.Z);
	Grow = 0.f;
	FlashLevel = 1.f;
	SetActorLocation(InTrainer->GetActorLocation() + InTrainer->GetActorForwardVector() * 120.f);
	SetActorRotation(FRotator(0.f, InTrainer->GetActorRotation().Yaw + 180.f, 0.f));
	return true;
}

void ALigaFollower::Recall()
{
	bRecalling = true;
	FlashLevel = 1.f;
}

void ALigaFollower::PlayClip(bool bWalk)
{
	bWalking = bWalk;
	if (!bSkeletal) return;
	UAnimSequence* Clip = (bWalk && WalkAnim) ? WalkAnim.Get() : IdleAnim.Get();
	if (Clip) Skel->PlayAnimation(Clip, true);
}

void ALigaFollower::Tick(float Dt)
{
	Super::Tick(Dt);
	APawn* T = Trainer.Get();
	if (!T)
	{
		Destroy();
		return;
	}
	// Hidden during battles and dialogues' cut-aways: the battle stage shows its own models.
	const ALigaPlayerController* PC = Cast<ALigaPlayerController>(T->GetController());
	const bool bShow = !PC || PC->Mode != ELigaMode::Battle;
	if (IsHidden() == bShow) SetActorHiddenInGame(!bShow);

	if (bRecalling)
	{
		Grow -= Dt / 0.25f;
		if (Grow <= 0.f)
		{
			Destroy();
			return;
		}
	}
	else
	{
		Grow = FMath::Min(1.f, Grow + Dt / 0.4f);
	}
	FlashLevel = FMath::Max(0.f, FlashLevel - Dt * 3.f);
	Flash->SetIntensity(FlashLevel * 8000.f);

	// Walk to a spot behind the trainer's right shoulder.
	const FVector TP = T->GetActorLocation();
	const FVector Fwd = T->GetActorForwardVector().GetSafeNormal2D();
	const FVector Goal = TP - Fwd * 110.f + T->GetActorRightVector() * 85.f;
	FVector Pos = GetActorLocation();
	FVector D = Goal - Pos;
	D.Z = 0.f;
	const float Dist = D.Size();
	if (Dist > 2500.f)
	{
		Pos = FVector(Goal.X, Goal.Y, Pos.Z);
		Velocity = FVector::ZeroVector;
	}
	else
	{
		const float MaxSpeed = FMath::Max(260.f, T->GetVelocity().Size2D() * 1.25f + 80.f);
		const FVector Want = Dist > 30.f ? D / Dist * FMath::Min(MaxSpeed, Dist * 4.f) : FVector::ZeroVector;
		Velocity = FMath::VInterpTo(Velocity, Want, Dt, 6.f);
		Pos += Velocity * Dt;
	}
	// Stand on the ground.
	FHitResult Hit;
	FCollisionQueryParams Q;
	Q.AddIgnoredActor(this);
	Q.AddIgnoredActor(T);
	if (GetWorld()->LineTraceSingleByChannel(Hit, FVector(Pos.X, Pos.Y, TP.Z + 60.f), FVector(Pos.X, Pos.Y, TP.Z - 500.f), ECC_Visibility, Q))
	{
		Pos.Z = Hit.ImpactPoint.Z;
	}
	else
	{
		Pos.Z = TP.Z - 88.f;
	}
	const float Speed = Velocity.Size2D();
	const float WantYaw = Speed > 20.f ? Velocity.Rotation().Yaw : T->GetActorRotation().Yaw;
	const FRotator Rot = FMath::RInterpTo(GetActorRotation(), FRotator(0.f, WantYaw, 0.f), Dt, 7.f);
	SetActorLocationAndRotation(Pos, FRotator(0.f, Rot.Yaw, 0.f));

	const bool bWalk = Speed > 45.f;
	if (bWalk != bWalking) PlayClip(bWalk);
	if (bSkeletal) Skel->SetPlayRate(bWalking && WalkAnim ? FMath::Clamp(Speed / 220.f, 0.6f, 2.2f) : 1.f);

	const float G = FMath::InterpEaseOut(0.f, 1.f, FMath::Clamp(Grow, 0.f, 1.f), 2.f);
	const float S = ModelScale * FMath::Max(0.01f, G);
	Body->SetRelativeScale3D(FVector(S));
	Body->SetRelativeLocation(FVector(0.f, 0.f, ModelLift * S));
}
