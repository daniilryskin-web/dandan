#include "LigaFollower.h"

#include "Animation/AnimSequence.h"
#include "Components/PointLightComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Pawn.h"
#include "Kismet/GameplayStatics.h"
#include "LigaAssets.h"
#include "LigaData.h"
#include "LigaGameInstance.h"
#include "LigaPlayerController.h"
#include "LigaQuests.h"
#include "Materials/MaterialInstanceDynamic.h"

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

bool ALigaFollower::LoadModel(bool bAllowPlaceholder)
{
	const FLigaModel3D* Def = FLigaAssets::Get().FindModel3D(Species, bShiny);
	UObject* Obj = Def ? LoadObject<UObject>(nullptr, *Def->Mesh, nullptr, LOAD_NoWarn | LOAD_Quiet) : nullptr;
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
	else if (bAllowPlaceholder)
	{
		// No 3D model on this computer: a small glowing ball marks the spot.
		UStaticMesh* Sphere = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
		if (!Sphere) return false;
		Static->SetStaticMesh(Sphere);
		if (UMaterialInterface* M = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial")))
		{
			UMaterialInstanceDynamic* MI = UMaterialInstanceDynamic::Create(M, this);
			MI->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.75f, 0.45f, 0.2f));
			Static->SetMaterial(0, MI);
		}
		Skel->SetVisibility(false);
		B = Sphere->GetBounds();
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
	return true;
}

bool ALigaFollower::Setup(APawn* InTrainer, int32 InSpecies, bool bInShiny)
{
	Trainer = InTrainer;
	Species = InSpecies;
	bShiny = bInShiny;
	if (!InTrainer || !LoadModel(false)) return false;
	Grow = 0.f;
	FlashLevel = 1.f;
	SetActorLocation(InTrainer->GetActorLocation() + InTrainer->GetActorForwardVector() * 120.f);
	SetActorRotation(FRotator(0.f, InTrainer->GetActorRotation().Yaw + 180.f, 0.f));
	return true;
}

bool ALigaFollower::SetupAmbient(int32 InSpecies, const FVector& InHome, float InRadius, const FString& InQuest)
{
	bAmbient = true;
	Species = InSpecies;
	Home = InHome;
	Radius = FMath::Max(50.f, InRadius);
	Quest = InQuest;
	if (!LoadModel(!Quest.IsEmpty())) return false;
	Grow = 1.f;
	WanderGoal = Home;
	WanderWait = FMath::FRandRange(0.5f, 3.f);
	SetActorLocation(Home);
	bQuestShown = Quest.IsEmpty() || QuestWantsMe();
	SetActorHiddenInGame(!bQuestShown);
	return true;
}

bool ALigaFollower::QuestWantsMe() const
{
	const ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	const FLigaQuestDef* Q = LigaQuests::Find(Quest);
	return GI && Q && LigaQuests::State(GI->Data, Q->Id) == 1 && !LigaQuests::IsComplete(GI->Data, *Q);
}

FString ALigaFollower::GetPromptText() const
{
	return Quest.IsEmpty() ? TEXT("Погладить") : TEXT("Позвать");
}

FString ALigaFollower::GetDisplayName() const
{
	const FLigaSpecies* S = FLigaDatabase::Get().Species(Species);
	return S ? S->Name : FString();
}

bool ALigaFollower::CanInteract() const
{
	return bAmbient && !IsHidden() && !bRecalling;
}

void ALigaFollower::Interact(ALigaPlayerController* PC)
{
	if (!PC || !CanInteract()) return;
	const FString Name = GetDisplayName();
	PetTimer = 1.2f;
	if (!Quest.IsEmpty())
	{
		// The lost Pokémon of a quest: found! It runs back home.
		if (ULigaGameInstance* GI = ULigaGameInstance::Get(this))
		{
			if (const FLigaQuestDef* Q = LigaQuests::Find(Quest)) LigaQuests::AddCounter(GI->Data, Q->Counter);
		}
		FlashLevel = 1.f;
		bRecalling = true;
		PC->ShowDialogue(FString(), {FString::Printf(TEXT("%s радостно подпрыгивает и бежит домой!"), *Name)}, [PC]() { PC->CheckQuests(); });
		return;
	}
	static const TCHAR* Lines[] = {
		TEXT("довольно жмурится."), TEXT("с любопытством разглядывает вас."), TEXT("радостно подпрыгивает!"), TEXT("тихонько напевает что-то своё."),
	};
	PC->ShowToast(Name + TEXT(" ") + Lines[FMath::RandRange(0, 3)], 2.5f);
}

float ALigaFollower::GroundZ(const FVector& At, float From) const
{
	FHitResult Hit;
	FCollisionQueryParams Q;
	Q.AddIgnoredActor(this);
	for (TActorIterator<APawn> It(GetWorld()); It; ++It) Q.AddIgnoredActor(*It);
	if (GetWorld()->LineTraceSingleByChannel(Hit, FVector(At.X, At.Y, From + 80.f), FVector(At.X, At.Y, From - 600.f), ECC_Visibility, Q))
	{
		return Hit.ImpactPoint.Z;
	}
	return At.Z;
}

void ALigaFollower::TickAmbient(float Dt)
{
	// Quest Pokémon appear only while their quest needs them; a found one runs home (shrinks away and stays hidden).
	QuestCheck -= Dt;
	if (!Quest.IsEmpty() && QuestCheck <= 0.f && !bRecalling)
	{
		QuestCheck = 0.5f;
		const bool bWant = QuestWantsMe();
		if (bWant != bQuestShown)
		{
			bQuestShown = bWant;
			if (bWant)
			{
				Grow = 0.f;
				FlashLevel = 1.f;
				SetActorLocation(Home);
			}
		}
	}
	const APawn* Player = UGameplayStatics::GetPlayerPawn(this, 0);
	const ALigaPlayerController* PC = Player ? Cast<ALigaPlayerController>(Player->GetController()) : nullptr;
	const bool bShow = bQuestShown && (!PC || PC->Mode != ELigaMode::Battle);
	if (IsHidden() == bShow) SetActorHiddenInGame(!bShow);
	if (bRecalling)
	{
		Grow -= Dt / 0.35f;
		if (Grow <= 0.f)
		{
			Grow = 0.f;
			bRecalling = false;
			bQuestShown = false;
			SetActorHiddenInGame(true);
		}
	}
	else if (bQuestShown)
	{
		Grow = FMath::Min(1.f, Grow + Dt / 0.4f);
	}
	FlashLevel = FMath::Max(0.f, FlashLevel - Dt * 3.f);
	Flash->SetIntensity(FlashLevel * 8000.f);

	FVector Pos = GetActorLocation();
	PetTimer = FMath::Max(0.f, PetTimer - Dt);
	const FVector ToPlayer = Player ? Player->GetActorLocation() - Pos : FVector::ZeroVector;
	const bool bNear = Player && ToPlayer.Size2D() < 250.f;
	FVector Want = FVector::ZeroVector;
	if (bNear || PetTimer > 0.f)
	{
		WanderWait = FMath::Max(WanderWait, 1.f);  // stops and looks at the player
	}
	else if (WanderWait > 0.f)
	{
		WanderWait -= Dt;
		if (WanderWait <= 0.f)
		{
			const FVector2D R = FMath::RandPointInCircle(Radius);
			WanderGoal = Home + FVector(R.X, R.Y, 0.f);
		}
	}
	else
	{
		FVector D = WanderGoal - Pos;
		D.Z = 0.f;
		if (D.Size() < 25.f) WanderWait = FMath::FRandRange(1.5f, 5.f);
		else Want = D.GetSafeNormal() * FMath::Min(140.0, D.Size() * 3.0);
	}
	Velocity = FMath::VInterpTo(Velocity, Want, Dt, 5.f);
	Pos += Velocity * Dt;
	// Never drift far from home (a bump or a long frame).
	const FVector Off = FVector(Pos.X - Home.X, Pos.Y - Home.Y, 0.f);
	if (Off.Size() > Radius * 1.5f) Pos = FVector(Home.X, Home.Y, Pos.Z) + Off.GetSafeNormal() * Radius * 1.5f;
	Pos.Z = GroundZ(Pos, Pos.Z);
	const float Speed = Velocity.Size2D();
	float WantYaw = GetActorRotation().Yaw;
	if (bNear || PetTimer > 0.f) WantYaw = ToPlayer.Rotation().Yaw;
	else if (Speed > 15.f) WantYaw = Velocity.Rotation().Yaw;
	const FRotator Rot = FMath::RInterpTo(GetActorRotation(), FRotator(0.f, WantYaw, 0.f), Dt, 5.f);
	SetActorLocationAndRotation(Pos, FRotator(0.f, Rot.Yaw, 0.f));
	const bool bWalk = Speed > 30.f;
	if (bWalk != bWalking) PlayClip(bWalk);
	if (bSkeletal) Skel->SetPlayRate(bWalking && WalkAnim ? FMath::Clamp(Speed / 160.f, 0.6f, 1.8f) : 1.f);
	// A happy hop when petted.
	const float Hop = PetTimer > 0.f ? FMath::Abs(FMath::Sin(PetTimer * 9.f)) * 18.f : 0.f;
	const float G = FMath::InterpEaseOut(0.f, 1.f, FMath::Clamp(Grow, 0.f, 1.f), 2.f);
	const float S = ModelScale * FMath::Max(0.01f, G);
	Body->SetRelativeScale3D(FVector(S));
	Body->SetRelativeLocation(FVector(0.f, 0.f, ModelLift * S + Hop));
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
	if (bAmbient)
	{
		TickAmbient(Dt);
		return;
	}
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
