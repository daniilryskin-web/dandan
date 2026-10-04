#include "LigaBattleStage.h"

#include "Animation/AnimSequence.h"
#include "Camera/CameraComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/GameplayStatics.h"
#include "LigaAssets.h"
#include "LigaData.h"
#include "LigaGameInstance.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "ProceduralMeshComponent.h"

namespace
{
	/** Real height (m) → billboard height (cm), clamped so tiny Pokémon stay visible and giants fit. */
	float BillboardHeight(int32 Species)
	{
		const FLigaSpecies* S = FLigaDatabase::Get().Species(Species);
		const float H = S ? S->Height : 1.f;
		return FMath::Clamp(H, 1.1f, 5.5f) * 100.f;
	}

	FLinearColor StageHex(const TCHAR* H) { return FLinearColor(FColor::FromHex(H)); }
}

ALigaBattleStage::ALigaBattleStage()
{
	PrimaryActorTick.bCanEverTick = true;
	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent = Root;
	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(Root);
	Camera->SetFieldOfView(55.f);
	for (int32 i = 0; i < 2; ++i)
	{
		UProceduralMeshComponent* M = CreateDefaultSubobject<UProceduralMeshComponent>(i == 0 ? TEXT("PlayerMon") : TEXT("EnemyMon"));
		M->SetupAttachment(Root);
		M->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		M->SetCastShadow(true);
		M->bCastHiddenShadow = false;
		Mons[i].Mesh = M;

		USkeletalMeshComponent* S = CreateDefaultSubobject<USkeletalMeshComponent>(i == 0 ? TEXT("PlayerModel") : TEXT("EnemyModel"));
		S->SetupAttachment(Root);
		S->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		S->SetVisibility(false);
		S->bCastHiddenShadow = false;
		Mons[i].Skel = S;
		UStaticMeshComponent* SM = CreateDefaultSubobject<UStaticMeshComponent>(i == 0 ? TEXT("PlayerModelStatic") : TEXT("EnemyModelStatic"));
		SM->SetupAttachment(Root);
		SM->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		SM->SetVisibility(false);
		SM->bCastHiddenShadow = false;
		Mons[i].Static = SM;
	}
	Ball = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Ball"));
	Ball->SetupAttachment(Root);
	Ball->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Ball->SetVisibility(false);
	if (UStaticMesh* Sphere = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere")))
	{
		Ball->SetStaticMesh(Sphere);
	}
	Ball->SetWorldScale3D(FVector(0.22f));
}

FVector ALigaBattleStage::GroundAt(const FVector& P) const
{
	FHitResult Hit;
	FCollisionQueryParams Q(SCENE_QUERY_STAT(LigaGround), false, this);
	if (Trainer) Q.AddIgnoredActor(Trainer);
	if (GetWorld()->LineTraceSingleByChannel(Hit, P + FVector(0, 0, 600), P - FVector(0, 0, 1500), ECC_Visibility, Q))
	{
		return Hit.ImpactPoint;
	}
	return P;
}

void ALigaBattleStage::Begin(APawn* PlayerPawn)
{
	Trainer = PlayerPawn;
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI || !GI->Battle || !PlayerPawn) return;
	FLigaBattle& B = *GI->Battle;

	Forward = PlayerPawn->GetActorForwardVector().GetSafeNormal2D();
	if (Forward.IsNearlyZero()) Forward = FVector::ForwardVector;
	Right = FVector::CrossProduct(FVector::UpVector, Forward).GetSafeNormal();
	const FVector P = PlayerPawn->GetActorLocation();
	SetActorLocation(P);
	const FVector Mine = GroundAt(P + Forward * 230.f - Right * 110.f);
	const FVector Foe = GroundAt(P + Forward * 820.f + Right * 70.f);
	Center = (Mine + Foe) * 0.5f;

	SetupMon(0, B.PlayerMon(), Mine);
	SetupMon(1, B.EnemyMon(), Foe);
	Mons[0].Anim = TEXT("hidden");
	Animate(1, TEXT("appear"));

	// Camera starts close to the wild Pokémon and pulls back (intro).
	CamPos = Foe - Forward * 350.f + Right * 260.f + FVector(0, 0, 160.f);
	LookPos = Foe + FVector(0, 0, Mons[1].Height * 0.5f);
	Camera->SetWorldLocation(CamPos);
	Camera->SetWorldRotation((LookPos - CamPos).Rotation());
	if (APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0))
	{
		PC->SetViewTargetWithBlend(this, 0.5f, VTBlend_Cubic);
	}
	bIntro = true;
	Play(B.Events);
}

void ALigaBattleStage::SetupMon(int32 Side, const FLigaPokemon& Pk, const FVector& Where)
{
	FLigaBillboard& M = Mons[Side];
	M.Species = Pk.Species;
	M.Uid = Pk.Uid;
	M.bShiny = Pk.bShiny;
	M.Home = Where;
	M.Height = BillboardHeight(Pk.Species);
	M.Anim = TEXT("idle");
	M.AnimTime = 0.f;
	M.bHasTexture = false;
	ShownUid[Side] = Pk.Uid;
	MaxHp[Side] = FMath::Max(1, LigaRules::MaxHp(Pk));

	// Quad in the local YZ plane facing +X, bottom centre at the origin; both windings so it is visible from either side.
	const float W = M.Height;
	const float H = M.Height;
	TArray<FVector> V = {FVector(0, -W / 2, 0), FVector(0, W / 2, 0), FVector(0, W / 2, H), FVector(0, -W / 2, H)};
	TArray<int32> Tri = {0, 2, 1, 0, 3, 2, 0, 1, 2, 0, 2, 3};
	TArray<FVector> N = {FVector::ForwardVector, FVector::ForwardVector, FVector::ForwardVector, FVector::ForwardVector};
	TArray<FVector2D> UV = {FVector2D(1, 1), FVector2D(0, 1), FVector2D(0, 0), FVector2D(1, 0)};
	if (Side == 0)
	{
		// Our Pokémon is seen from behind-left: mirror it so it faces the opponent.
		Swap(UV[0], UV[1]);
		Swap(UV[2], UV[3]);
	}
	M.Mesh->CreateMeshSection(0, V, Tri, N, UV, {}, {}, false);
	M.Mesh->SetWorldLocation(Where);
	M.Mesh->SetVisibility(false);

	if (UMaterialInterface* Base = FLigaAssets::Get().LoadBillboardMaterial())
	{
		M.Mat = UMaterialInstanceDynamic::Create(Base, this);
		M.Mesh->SetMaterial(0, M.Mat);
	}
	if (ULigaGameInstance* GI = ULigaGameInstance::Get(this))
	{
		TWeakObjectPtr<ALigaBattleStage> WeakThis(this);
		const int32 Species = Pk.Species;
		GI->RequestPokemonTexture(Pk.Species, Pk.bShiny, FLigaTextureReady::CreateLambda([WeakThis, Side, Species](UTexture2D* Tex)
		{
			if (WeakThis.IsValid() && WeakThis->Mons[Side].Species == Species) WeakThis->SetMonTexture(Side, Tex);
		}));
	}
	ShownHp[Side] = TargetHp[Side] = Pk.HP;
	ShownStatus[Side] = Pk.GetStatus();
	SetupModel(Side, Pk);
}

namespace
{
	/** A model without an idle clip stands in the first frame of its pose clip: some rest poses are not meant to be seen. */
	void ShowPose(FLigaBillboard& M)
	{
		if (!M.PoseAnim) return;
		M.Skel->PlayAnimation(M.PoseAnim.Get(), false);
		M.Skel->Stop();
		M.bPosed = true;
	}
}

bool ALigaBattleStage::SetupModel(int32 Side, const FLigaPokemon& Pk)
{
	FLigaBillboard& M = Mons[Side];
	M.bModel = M.bSkeletal = M.bPosed = false;
	M.IdleAnim = M.AttackAnim = M.FaintAnim = M.PoseAnim = nullptr;
	M.Skel->SetVisibility(false);
	M.Static->SetVisibility(false);
	const FLigaModel3D* Def = FLigaAssets::Get().FindModel3D(Pk.Species, Pk.bShiny);
	if (!Def) return false;
	UObject* Obj = LoadObject<UObject>(nullptr, *Def->Mesh, nullptr, LOAD_NoWarn | LOAD_Quiet);
	FBoxSphereBounds B(ForceInit);
	if (USkeletalMesh* SK = Cast<USkeletalMesh>(Obj))
	{
		M.Skel->SetSkeletalMesh(SK);
		M.Skel->SetAnimationMode(EAnimationMode::AnimationSingleNode);
		auto LoadAnim = [](const FString& Path) { return Path.IsEmpty() ? nullptr : LoadObject<UAnimSequence>(nullptr, *Path, nullptr, LOAD_NoWarn | LOAD_Quiet); };
		M.IdleAnim = LoadAnim(Def->Idle);
		M.AttackAnim = LoadAnim(Def->Attack);
		M.FaintAnim = LoadAnim(Def->Faint);
		M.PoseAnim = LoadAnim(Def->Pose);
		if (M.IdleAnim) M.Skel->PlayAnimation(M.IdleAnim.Get(), true);
		else ShowPose(M);
		B = SK->GetBounds();
		M.bSkeletal = true;
	}
	else if (UStaticMesh* SM = Cast<UStaticMesh>(Obj))
	{
		M.Static->SetStaticMesh(SM);
		B = SM->GetBounds();
	}
	else
	{
		return false;
	}
	// Fit the model to the same size the picture would have: by height, and not wider than the stage allows.
	const float H = FMath::Max(1.f, B.BoxExtent.Z * 2.f);
	const float W = FMath::Max(1.f, FMath::Max(B.BoxExtent.X, B.BoxExtent.Y) * 2.f);
	M.ModelScale = FMath::Min(M.Height * 0.8f / H, M.Height * 1.5f / W);
	M.ModelLift = -(B.Origin.Z - B.BoxExtent.Z);
	M.ModelCenter = FVector(B.Origin.X, B.Origin.Y, 0.f);
	M.bModel = true;
	M.Mesh->SetVisibility(false);
	return true;
}

void ALigaBattleStage::SetMonTexture(int32 Side, UTexture2D* Tex)
{
	FLigaBillboard& M = Mons[Side];
	if (!M.Mat || !Tex) return;
	M.Mat->SetTextureParameterValue(TEXT("Tex"), Tex);
	M.Mat->SetTextureParameterValue(TEXT("SlateUI"), Tex);
	M.bHasTexture = true;
}

void ALigaBattleStage::Animate(int32 Side, FName Anim)
{
	FLigaBillboard& M = Mons[Side];
	M.Anim = Anim;
	M.AnimTime = 0.f;
	if (M.bModel && M.bSkeletal)
	{
		UAnimSequence* Clip = Anim == TEXT("attack") ? M.AttackAnim.Get() : Anim == TEXT("faint") ? M.FaintAnim.Get() : nullptr;
		if (Clip)
		{
			M.Skel->PlayAnimation(Clip, false);
			M.bPosed = false;
		}
		else if (M.IdleAnim && !M.Skel->IsPlaying()) M.Skel->PlayAnimation(M.IdleAnim.Get(), true);
	}
}

void ALigaBattleStage::Play(const TArray<FLigaBattleEvent>& Events)
{
	Queue.Append(Events);
	bFast = false;
}

void ALigaBattleStage::AddPopup(int32 Side, const FString& Text, const FLinearColor& Color)
{
	FLigaPopup& P = Popups.AddDefaulted_GetRef();
	P.Text = Text;
	P.Color = Color;
	P.World = Mons[Side].Home + FVector(0, 0, Mons[Side].Height + 30.f);
}

void ALigaBattleStage::NextEvent()
{
	if (Queue.Num() == 0) return;
	const FLigaBattleEvent E = Queue[0];
	Queue.RemoveAt(0);
	const int32 S = (int32)E.Side;
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	switch (E.T)
	{
	case ELigaEvent::Msg:
		if (bIntro && E.Text.StartsWith(TEXT("Вперёд")))
		{
			bIntro = false;
			Animate(0, TEXT("appear"));
		}
		Message = E.Text;
		Wait = FMath::Min(1.8f, 0.75f + E.Text.Len() * 0.018f);
		break;
	case ELigaEvent::Move:
	{
		const FLigaMove* Mv = FLigaDatabase::Get().Move(E.MoveId);
		Focus = S == 0 ? 1 : 2;
		if (Mv && Mv->Category != EMoveCategory::Status) Animate(S, TEXT("attack"));
		Wait = 0.45f;
		break;
	}
	case ELigaEvent::Damage:
	{
		Animate(S, TEXT("hit"));
		TargetHp[S] = E.Hp;
		const FLinearColor C = E.bCrit ? StageHex(TEXT("FFD84A")) : E.Eff >= 2.f ? StageHex(TEXT("FF8A3A")) : E.Eff < 1.f ? StageHex(TEXT("B8C0D8")) : FLinearColor::White;
		AddPopup(S, FString::Printf(TEXT("-%d"), E.Amount), C);
		if (E.bCrit || E.Eff >= 2.f) Shake = 0.35f;
		Wait = E.bCrit || E.Eff >= 2.f ? 0.7f : 0.5f;
		break;
	}
	case ELigaEvent::Heal:
		TargetHp[S] = E.Hp;
		AddPopup(S, FString::Printf(TEXT("+%d"), E.Amount), StageHex(TEXT("6DFFA0")));
		Wait = 0.5f;
		break;
	case ELigaEvent::Status:
		ShownStatus[S] = E.Status;
		Wait = 0.35f;
		break;
	case ELigaEvent::Stat:
		AddPopup(S, E.Delta > 0 ? TEXT("+") : TEXT("-"), E.Delta > 0 ? StageHex(TEXT("5EC8FF")) : StageHex(TEXT("FF6A6A")));
		Wait = 0.3f;
		break;
	case ELigaEvent::Faint:
		Animate(S, TEXT("faint"));
		Wait = 0.9f;
		break;
	case ELigaEvent::Switch:
		if (GI && GI->Battle)
		{
			const FLigaPokemon* P = nullptr;
			if (S == 0) P = GI->Data.FindByUid(E.Uid);
			else
			{
				for (const FLigaPokemon& X : GI->Battle->EnemyTeam)
				{
					if (X.Uid == E.Uid) P = &X;
				}
			}
			if (P)
			{
				const int32 Hp = P->HP;
				// HP right after the switch, before later damage events of the same turn.
				SetupMon(S, *P, Mons[S].Home);
				int32 Back = 0;
				for (const FLigaBattleEvent& Later : Queue)
				{
					if (Later.T == ELigaEvent::Switch && (int32)Later.Side == S) break;
					if (Later.T == ELigaEvent::Damage && (int32)Later.Side == S) { Back = Later.Amount; break; }
				}
				ShownHp[S] = TargetHp[S] = Hp + Back;
				if (UTexture2D* T = GI->GetCachedTexture(P->Species, P->bShiny)) SetMonTexture(S, T);
				Animate(S, TEXT("appear"));
			}
		}
		bIntro = false;
		Wait = 0.55f;
		break;
	case ELigaEvent::Ball:
		bBallActive = true;
		BallTime = 0.f;
		BallShakes = E.Shakes;
		bBallCaught = E.bCaught;
		Focus = 1;
		if (BallMat == nullptr)
		{
			if (UMaterialInterface* M = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial")))
			{
				BallMat = UMaterialInstanceDynamic::Create(M, this);
				Ball->SetMaterial(0, BallMat);
			}
		}
		if (BallMat) BallMat->SetVectorParameterValue(TEXT("Color"), StageHex(TEXT("E53935")));
		Ball->SetVisibility(true);
		break;
	case ELigaEvent::Exp:
		if (E.Uid == ShownUid[0]) AddPopup(0, FString::Printf(TEXT("+%d EXP"), E.Amount), StageHex(TEXT("9FD8FF")));
		Wait = 0.2f;
		break;
	case ELigaEvent::LevelUp:
		if (E.Uid == ShownUid[0] && GI)
		{
			if (const FLigaPokemon* P = GI->Data.FindByUid(E.Uid)) MaxHp[0] = LigaRules::MaxHp(*P);
			AddPopup(0, FString::Printf(TEXT("LV %d"), E.Level), StageHex(TEXT("FFD54F")));
		}
		Wait = 0.4f;
		break;
	default:
		Wait = 0.1f;
		break;
	}
	if (bFast) Wait = FMath::Min(Wait, 0.12f);
}

void ALigaBattleStage::Tick(float Dt)
{
	Super::Tick(Dt);
	Time += Dt;
	for (int32 i = 0; i < 2; ++i)
	{
		// HP bars drain smoothly towards the target value.
		if (ShownHp[i] != TargetHp[i])
		{
			const int32 Step = FMath::Max(1, FMath::CeilToInt(MaxHp[i] * Dt * 1.2f * Speed()));
			ShownHp[i] = ShownHp[i] > TargetHp[i] ? FMath::Max(TargetHp[i], ShownHp[i] - Step) : FMath::Min(TargetHp[i], ShownHp[i] + Step);
		}
		UpdateMon(i, Dt);
	}
	for (int32 i = Popups.Num() - 1; i >= 0; --i)
	{
		Popups[i].Age += Dt;
		if (Popups[i].Age > 1.4f) Popups.RemoveAt(i);
	}
	if (bBallActive) UpdateBall(Dt * Speed());
	else if (Wait > 0.f) Wait -= Dt * Speed();
	else if (Queue.Num() > 0) NextEvent();
	else Focus = 0;
	UpdateCamera(Dt);
}

void ALigaBattleStage::UpdateMon(int32 Side, float Dt)
{
	FLigaBillboard& M = Mons[Side];
	if (!M.Mesh) return;
	M.AnimTime += Dt * Speed();
	const float T = M.AnimTime;
	FVector Offset(0, 0, 4.f + FMath::Sin(Time * 2.2f + Side) * 3.f);
	float Scale = 1.f;
	float Flash = 0.f;
	const FVector Toward = Side == 0 ? Forward : -Forward;
	if (M.Anim == TEXT("attack"))
	{
		const float P = FMath::Clamp(T / 0.45f, 0.f, 1.f);
		Offset += Toward * FMath::Sin(P * PI) * 140.f + FVector(0, 0, FMath::Sin(P * PI) * 30.f);
	}
	else if (M.Anim == TEXT("hit"))
	{
		const float P = FMath::Clamp(T / 0.55f, 0.f, 1.f);
		Offset += Right * FMath::Sin(T * 55.f) * 12.f * (1.f - P);
		Flash = (P < 1.f && FMath::FloorToInt(T * 12.f) % 2 == 0) ? 0.8f : 0.f;
	}
	else if (M.Anim == TEXT("faint"))
	{
		const float P = FMath::Clamp(T / 0.75f, 0.f, 1.f);
		Offset.Z -= P * M.Height * 0.7f;
		Scale = 1.f - P * 0.3f;
	}
	else if (M.Anim == TEXT("appear"))
	{
		const float P = FMath::Clamp(T / 0.45f, 0.f, 1.f);
		Scale = 0.15f + 0.85f * (1.f - FMath::Pow(1.f - P, 3.f));
		Flash = (1.f - P) * 0.9f;
	}
	else if (M.Anim == TEXT("capture"))
	{
		const float P = FMath::Clamp(T / 0.4f, 0.f, 1.f);
		Scale = FMath::Max(0.01f, 1.f - P);
		Flash = 1.f;
	}
	const bool bGone = M.Anim == TEXT("hidden") || (M.Anim == TEXT("faint") && T >= 0.75f) || (M.Anim == TEXT("capture") && T >= 0.4f);
	if (M.bModel)
	{
		// 3D model: same motion as the picture; blinks when hit, breathes a little, faces its opponent.
		USceneComponent* C = M.bSkeletal ? static_cast<USceneComponent*>(M.Skel.Get()) : static_cast<USceneComponent*>(M.Static.Get());
		const bool bBlink = M.Anim == TEXT("hit") && Flash > 0.f;
		const bool bShow = !bGone && !bBlink;
		if (C->IsVisible() != bShow) C->SetVisibility(bShow);
		if (M.Mesh->IsVisible()) M.Mesh->SetVisibility(false);
		const float S = M.ModelScale * Scale;
		const float Breath = 1.f + 0.015f * FMath::Sin(Time * 2.4f + Side * 1.7f);
		// Imported glTF models face +Y in their own space.
		const FRotator Rot(0.f, Toward.Rotation().Yaw - 90.f, 0.f);
		C->SetWorldLocation(M.Home + Offset + FVector(0, 0, M.ModelLift * S) - Rot.RotateVector(M.ModelCenter * S));
		C->SetWorldScale3D(FVector(S, S, S * Breath));
		C->SetWorldRotation(Rot);
		if (M.bSkeletal && M.Anim != TEXT("faint") && !M.Skel->IsPlaying())
		{
			if (M.IdleAnim) M.Skel->PlayAnimation(M.IdleAnim.Get(), true);
			else if (!M.bPosed) ShowPose(M);  // back from an attack clip
		}
		return;
	}
	const bool bVisible = M.bHasTexture && !bGone;
	if (M.Mesh->IsVisible() != bVisible) M.Mesh->SetVisibility(bVisible);
	M.Mesh->SetWorldLocation(M.Home + Offset);
	M.Mesh->SetWorldScale3D(FVector(1.f, Scale, Scale));
	// Face the camera around the vertical axis only.
	const FVector ToCam = (Camera->GetComponentLocation() - M.Mesh->GetComponentLocation()).GetSafeNormal2D();
	if (!ToCam.IsNearlyZero()) M.Mesh->SetWorldRotation(ToCam.Rotation());
	if (M.Mat) M.Mat->SetScalarParameterValue(TEXT("Flash"), Flash);
}

void ALigaBattleStage::UpdateBall(float Dt)
{
	BallTime += Dt;
	const FVector From = (Trainer ? Trainer->GetActorLocation() : Mons[0].Home) + FVector(0, 0, 60.f);
	const FVector Top = Mons[1].Home + FVector(0, 0, Mons[1].Height * 0.75f) - Forward * 60.f;
	const FVector Ground = Mons[1].Home + FVector(0, 0, 22.f) - Forward * 60.f;
	const float CaptureAt = 0.65f;
	const float LandAt = 1.25f;
	const float ResultAt = LandAt + BallShakes * 0.65f + 0.25f;
	if (BallTime < CaptureAt)
	{
		const float P = BallTime / CaptureAt;
		Ball->SetWorldLocation(FMath::Lerp(From, Top, P) + FVector(0, 0, FMath::Sin(P * PI) * 220.f));
		Ball->SetWorldRotation(FRotator(-P * 800.f, 0, 0));
	}
	else if (BallTime < LandAt)
	{
		if (Mons[1].Anim != TEXT("capture")) Animate(1, TEXT("capture"));
		const float P = (BallTime - CaptureAt) / (LandAt - CaptureAt);
		Ball->SetWorldLocation(FMath::Lerp(Top, Ground, P * P));
	}
	else if (BallTime < ResultAt)
	{
		Ball->SetWorldLocation(Ground);
		const float Local = FMath::Fmod(BallTime - LandAt, 0.65f);
		const bool bShaking = BallTime - LandAt < BallShakes * 0.65f && Local < 0.38f;
		Ball->SetWorldRotation(FRotator(0, 0, bShaking ? FMath::Sin(Local / 0.38f * 2.f * PI) * 28.f : 0.f));
	}
	else
	{
		bBallActive = false;
		if (!bBallCaught)
		{
			Ball->SetVisibility(false);
			Animate(1, TEXT("appear"));
		}
		Wait = 0.5f;
	}
}

void ALigaBattleStage::UpdateCamera(float Dt)
{
	const FVector Mine = Mons[0].Home;
	const FVector Foe = Mons[1].Home;
	if (bIntro)
	{
		CamGoal = Foe - Forward * 520.f + Right * 300.f + FVector(0, 0, 170.f);
		LookGoal = Foe + FVector(0, 0, Mons[1].Height * 0.45f);
	}
	else if (Focus == 1)
	{
		CamGoal = Mine - Forward * 300.f - Right * 130.f + FVector(0, 0, 200.f);
		LookGoal = Foe + FVector(0, 0, Mons[1].Height * 0.4f);
	}
	else if (Focus == 2)
	{
		CamGoal = Foe + Forward * 120.f + Right * 260.f + FVector(0, 0, 230.f);
		LookGoal = Mine + FVector(0, 0, Mons[0].Height * 0.4f);
	}
	else
	{
		CamGoal = Mine - Forward * 520.f - Right * 220.f + FVector(0, 0, 260.f + FMath::Sin(Time * 0.4f) * 12.f) + Right * FMath::Sin(Time * 0.25f) * 40.f;
		LookGoal = Center + FVector(0, 0, 90.f) + Right * 60.f;
	}
	const float K = 1.f - FMath::Exp(-Dt * (bIntro ? 2.2f : 3.0f));
	CamPos = FMath::Lerp(CamPos, CamGoal, K);
	LookPos = FMath::Lerp(LookPos, LookGoal, K);
	FVector Jitter = FVector::ZeroVector;
	if (Shake > 0.f)
	{
		Shake -= Dt;
		Jitter = FVector(FMath::FRandRange(-1.f, 1.f), FMath::FRandRange(-1.f, 1.f), FMath::FRandRange(-1.f, 1.f)) * 10.f * FMath::Max(0.f, Shake / 0.35f);
	}
	Camera->SetWorldLocation(CamPos + Jitter);
	Camera->SetWorldRotation((LookPos - CamPos).Rotation());
}

void ALigaBattleStage::Finish()
{
	if (APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0))
	{
		if (Trainer) PC->SetViewTargetWithBlend(Trainer, 0.6f, VTBlend_Cubic);
	}
	SetLifeSpan(0.8f);
}
