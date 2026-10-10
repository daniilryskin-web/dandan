#include "LigaBattleStage.h"

#include "Animation/AnimSequence.h"
#include "Camera/CameraComponent.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/GameplayStatics.h"
#include "EngineUtils.h"
#include "LigaAssets.h"
#include "LigaBattleFx.h"
#include "LigaData.h"
#include "LigaGameInstance.h"
#include "LigaWorldBuilder.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "ProceduralMeshComponent.h"

namespace
{
	constexpr float BallR = 11.f;  // Poké Ball radius, cm

	/** Geometry of a part of the Poké Ball (centre at the origin, front = +X, up = +Z). */
	struct FBallMesh
	{
		TArray<FVector> V;
		TArray<int32> Tris;
		TArray<FVector> N;
		TArray<FVector2D> UV;

		int32 Vert(const FVector& P, const FVector& Nrm)
		{
			N.Add(Nrm);
			UV.Add(FVector2D(P.Y, P.Z) * 0.05f);
			return V.Add(P);
		}
		void Tri(int32 A, int32 B, int32 C, const FVector& Out)
		{
			// Unreal's front face has (P1 - P2) ^ (P0 - P2) pointing outwards (as in its procedural mesh tangents).
			const FVector Face = (V[B] - V[C]) ^ (V[A] - V[C]);
			if ((Face | Out) < 0.f) Swap(B, C);
			Tris.Add(A);
			Tris.Add(B);
			Tris.Add(C);
		}
		/** The sphere surface between two latitudes (degrees, -90 bottom .. 90 top). */
		void Band(float R, float Lat0, float Lat1, int32 Segs = 48, int32 Rings = 10)
		{
			TArray<int32> Idx;
			for (int32 i = 0; i <= Rings; ++i)
			{
				const float Lat = FMath::DegreesToRadians(FMath::Lerp(Lat0, Lat1, float(i) / Rings));
				for (int32 j = 0; j <= Segs; ++j)
				{
					const float Lon = 2.f * PI * j / Segs;
					const FVector Dir(FMath::Cos(Lat) * FMath::Cos(Lon), FMath::Cos(Lat) * FMath::Sin(Lon), FMath::Sin(Lat));
					Idx.Add(Vert(Dir * R, Dir));
				}
			}
			for (int32 i = 0; i < Rings; ++i)
			{
				for (int32 j = 0; j < Segs; ++j)
				{
					const int32 A = Idx[i * (Segs + 1) + j];
					const int32 B = Idx[(i + 1) * (Segs + 1) + j];
					const int32 C = Idx[i * (Segs + 1) + j + 1];
					const int32 D = Idx[(i + 1) * (Segs + 1) + j + 1];
					const FVector Out = V[A] + V[B] + V[C] + V[D];
					Tri(A, B, C, Out);
					Tri(C, B, D, Out);
				}
			}
		}
		/** A flat disc of radius R at At, facing Normal. */
		void Disc(const FVector& At, const FVector& Normal, float R, int32 Segs = 48)
		{
			const FVector U = FVector::CrossProduct(Normal, FMath::Abs(Normal.Z) < 0.9f ? FVector::UpVector : FVector::ForwardVector).GetSafeNormal();
			const FVector W = FVector::CrossProduct(Normal, U);
			const int32 Mid = Vert(At, Normal);
			TArray<int32> Ring;
			for (int32 j = 0; j <= Segs; ++j)
			{
				const float Ang = 2.f * PI * j / Segs;
				Ring.Add(Vert(At + (U * FMath::Cos(Ang) + W * FMath::Sin(Ang)) * R, Normal));
			}
			for (int32 j = 0; j < Segs; ++j) Tri(Mid, Ring[j], Ring[j + 1], Normal);
		}
		/** The side of a cylinder of radius R from At along Axis, Length long. */
		void Tube(const FVector& At, const FVector& Axis, float R, float Length, int32 Segs = 40)
		{
			const FVector U = FVector::CrossProduct(Axis, FMath::Abs(Axis.Z) < 0.9f ? FVector::UpVector : FVector::ForwardVector).GetSafeNormal();
			const FVector W = FVector::CrossProduct(Axis, U);
			TArray<int32> Idx;
			for (int32 j = 0; j <= Segs; ++j)
			{
				const float Ang = 2.f * PI * j / Segs;
				const FVector Dir = U * FMath::Cos(Ang) + W * FMath::Sin(Ang);
				Idx.Add(Vert(At + Dir * R, Dir));
				Idx.Add(Vert(At + Dir * R + Axis * Length, Dir));
			}
			for (int32 j = 0; j < Segs; ++j)
			{
				const int32 A = Idx[2 * j];
				const int32 B = Idx[2 * j + 1];
				const int32 C = Idx[2 * j + 2];
				const int32 D = Idx[2 * j + 3];
				const FVector Out = N[A] + N[C];
				Tri(A, B, C, Out);
				Tri(C, B, D, Out);
			}
		}
		void Into(UProceduralMeshComponent* Part, int32 Section, UMaterialInterface* Mat) const
		{
			Part->CreateMeshSection(Section, V, Tris, N, UV, TArray<FColor>(), TArray<FProcMeshTangent>(), false);
			Part->SetMaterial(Section, Mat);
		}
	};

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
	Ball = CreateDefaultSubobject<USceneComponent>(TEXT("Ball"));
	Ball->SetupAttachment(Root);
	BallLower = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("BallLower"));
	BallLower->SetupAttachment(Ball);
	BallHinge = CreateDefaultSubobject<USceneComponent>(TEXT("BallHinge"));
	BallHinge->SetupAttachment(Ball);
	BallHinge->SetRelativeLocation(FVector(-BallR, 0.f, 0.f));
	BallLid = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("BallLid"));
	BallLid->SetupAttachment(BallHinge);
	BallLid->SetRelativeLocation(FVector(BallR, 0.f, 0.f));
	BallLower->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	BallLid->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Ball->SetVisibility(false, true);
}

void ALigaBattleStage::BuildBall()
{
	if (BallMats.Num() > 0) return;
	UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (!Base) return;
	auto MakeMat = [this, Base](const TCHAR* Hex)
	{
		UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(Base, this);
		Mid->SetVectorParameterValue(TEXT("Color"), StageHex(Hex));
		BallMats.Add(Mid);
		return Mid;
	};
	UMaterialInstanceDynamic* Red = MakeMat(TEXT("E3262B"));
	UMaterialInstanceDynamic* White = MakeMat(TEXT("F2F2EE"));
	UMaterialInstanceDynamic* Black = MakeMat(TEXT("1C1C20"));
	BallButton = MakeMat(TEXT("FAFAFA"));
	const float R = BallR;
	const float Belt = 6.f;  // half the width of the black band, degrees of latitude
	FBallMesh Shell, Band, Button;
	Shell.Band(R, -90.f, -Belt);
	Band.Band(R * 1.006f, -Belt, 0.f);
	Band.Disc(FVector::ZeroVector, FVector::UpVector, R * 0.995f);           // the inside, seen when the lid is open
	Band.Tube(FVector(R * 0.84f, 0.f, 0.f), FVector::ForwardVector, R * 0.36f, R * 0.17f);  // black ring round the button
	Band.Disc(FVector(R * 1.01f, 0.f, 0.f), FVector::ForwardVector, R * 0.36f);
	Button.Tube(FVector(R * 0.97f, 0.f, 0.f), FVector::ForwardVector, R * 0.22f, R * 0.09f);
	Button.Disc(FVector(R * 1.06f, 0.f, 0.f), FVector::ForwardVector, R * 0.22f);
	Shell.Into(BallLower, 0, White);
	Band.Into(BallLower, 1, Black);
	Button.Into(BallLower, 2, BallButton);
	FBallMesh Dome, Rim;
	Dome.Band(R, Belt, 90.f);
	Rim.Band(R * 1.006f, 0.f, Belt);
	Rim.Disc(FVector::ZeroVector, -FVector::UpVector, R * 0.995f);
	Dome.Into(BallLid, 0, Red);
	Rim.Into(BallLid, 1, Black);
}

FVector ALigaBattleStage::GroundAt(const FVector& P) const
{
	FHitResult Hit;
	FCollisionQueryParams Q(SCENE_QUERY_STAT(LigaGround), false, this);
	if (Trainer) Q.AddIgnoredActor(Trainer);
	FVector G = P;
	if (GetWorld()->LineTraceSingleByChannel(Hit, P + FVector(0, 0, 600), P - FVector(0, 0, 1500), ECC_Visibility, Q))
	{
		G = Hit.ImpactPoint;
	}
	// Water has no collision: a Pokémon in the sea or a pond floats on the surface instead of standing on the bottom.
	const float WaterZ = Builder.IsValid() ? Builder->WaterZAt(G) : SeaZ;
	G.Z = FMath::Max(G.Z, (double)WaterZ);
	return G;
}

float ALigaBattleStage::FxHeight(int32 Side) const
{
	return Mons[Side].Height * (Mons[Side].bModel ? 0.8f : 0.9f);
}

void ALigaBattleStage::UpdateAura(int32 Side)
{
	if (!Fx) return;
	const bool bShown = Mons[Side].Anim != TEXT("hidden") && Mons[Side].Anim != TEXT("faint") && Mons[Side].Anim != TEXT("capture");
	Fx->SetAura(Side, bShown ? ShownStatus[Side] : EStatus::None, Mons[Side].Home, FxHeight(Side));
}

void ALigaBattleStage::Destroyed()
{
	if (Fx) Fx->Destroy();
	Fx = nullptr;
	Super::Destroyed();
}

void ALigaBattleStage::Begin(APawn* PlayerPawn)
{
	Trainer = PlayerPawn;
	ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	if (!GI || !GI->Battle || !PlayerPawn) return;
	FLigaBattle& B = *GI->Battle;

	for (TActorIterator<ALigaWorldBuilder> It(GetWorld()); It; ++It)
	{
		SeaZ = It->SeaLevelZ();
		Builder = *It;
		break;
	}
	FActorSpawnParameters FxParams;
	FxParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	Fx = GetWorld()->SpawnActor<ALigaBattleFx>(PlayerPawn->GetActorLocation(), FRotator::ZeroRotator, FxParams);
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
	UpdateAura(0);
	UpdateAura(1);
	if (Fx) Fx->BallOpen(Foe + FVector(0, 0, FxHeight(1) * 0.4f), FxHeight(1));

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
			UpdateAura(0);
			if (Fx) Fx->BallOpen(Mons[0].Home + FVector(0, 0, FxHeight(0) * 0.4f), FxHeight(0));
		}
		Message = E.Text;
		Wait = FMath::Min(1.8f, 0.75f + E.Text.Len() * 0.018f);
		break;
	case ELigaEvent::Move:
	{
		const FLigaMove* Mv = FLigaDatabase::Get().Move(E.MoveId);
		Focus = S == 0 ? 1 : 2;
		// Physical moves lunge at the foe; special and status moves are cast from where the Pokémon stands.
		if (Mv && Mv->Category == EMoveCategory::Physical) Animate(S, TEXT("attack"));
		else if (Mv) Animate(S, TEXT("cast"));
		Wait = 0.45f;
		if (Fx && Mv) Wait = Fx->PlayMove(*Mv, Mons[S].Home, FxHeight(S), Mons[1 - S].Home, FxHeight(1 - S));
		if (Mv && Mv->Type == EPokeType::Ground && Mv->Category != EMoveCategory::Status) Shake = FMath::Max(Shake, 0.3f);
		break;
	}
	case ELigaEvent::Damage:
	{
		Animate(S, TEXT("hit"));
		if (Fx)
		{
			if (E.MoveId.StartsWith(TEXT("status:")) || E.MoveId == TEXT("recoil")) Fx->StatusDamage(E.MoveId, Mons[S].Home, FxHeight(S));
			else
			{
				const FLigaMove* Mv = FLigaDatabase::Get().Move(E.MoveId);
				Fx->Impact(Mv ? Mv->Type : EPokeType::Normal, E.MoveId, Mons[S].Home, FxHeight(S), E.bCrit || E.Eff >= 2.f);
			}
		}
		TargetHp[S] = E.Hp;
		const FLinearColor C = E.bCrit ? StageHex(TEXT("FFD84A")) : E.Eff >= 2.f ? StageHex(TEXT("FF8A3A")) : E.Eff < 1.f ? StageHex(TEXT("B8C0D8")) : FLinearColor::White;
		AddPopup(S, FString::Printf(TEXT("-%d"), E.Amount), C);
		if (E.bCrit || E.Eff >= 2.f) Shake = 0.35f;
		Wait = E.bCrit || E.Eff >= 2.f ? 0.7f : 0.5f;
		break;
	}
	case ELigaEvent::Heal:
		if (Fx) Fx->Heal(Mons[S].Home, FxHeight(S));
		TargetHp[S] = E.Hp;
		AddPopup(S, FString::Printf(TEXT("+%d"), E.Amount), StageHex(TEXT("6DFFA0")));
		Wait = 0.5f;
		break;
	case ELigaEvent::Status:
		ShownStatus[S] = E.Status;
		if (Fx) Fx->StatusBurst(E.Status, Mons[S].Home, FxHeight(S));
		UpdateAura(S);
		SleepTimer[S] = 0.4f;
		Wait = E.Status == EStatus::None ? 0.35f : 0.6f;
		break;
	case ELigaEvent::Confuse:
		if (Fx) Fx->Confused(Mons[S].Home, FxHeight(S));
		Wait = 0.5f;
		break;
	case ELigaEvent::Protect:
		if (Fx) Fx->Shield(Mons[S].Home, FxHeight(S));
		Wait = 0.4f;
		break;
	case ELigaEvent::Miss:
		if (Fx) Fx->Miss(Mons[1 - S].Home, FxHeight(1 - S));
		Wait = 0.2f;
		break;
	case ELigaEvent::Stat:
		AddPopup(S, E.Delta > 0 ? TEXT("+") : TEXT("-"), E.Delta > 0 ? StageHex(TEXT("5EC8FF")) : StageHex(TEXT("FF6A6A")));
		if (Fx) Fx->StatChange(Mons[S].Home, FxHeight(S), E.Delta > 0);
		Wait = 0.5f;
		break;
	case ELigaEvent::Faint:
		Animate(S, TEXT("faint"));
		if (Fx) Fx->Faint(Mons[S].Home, FxHeight(S));
		UpdateAura(S);
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
				UpdateAura(S);
				if (Fx) Fx->BallOpen(Mons[S].Home + FVector(0, 0, FxHeight(S) * 0.4f), FxHeight(S));
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
		BallTrailClock = 0.f;
		BuildBall();
		BallHinge->SetRelativeRotation(FRotator::ZeroRotator);
		if (BallButton) BallButton->SetVectorParameterValue(TEXT("Color"), StageHex(TEXT("FAFAFA")));
		Ball->SetVisibility(true, true);
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
	if (Fx)
	{
		Fx->ViewPos = Camera->GetComponentLocation();
		if (APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0))
		{
			if (PC->PlayerCameraManager) Fx->ViewPos = PC->PlayerCameraManager->GetCameraLocation();
		}
	}
	for (int32 i = 0; i < 2; ++i)
	{
		// "Z" floating up from a sleeping Pokémon.
		if (ShownStatus[i] != EStatus::Sleep || Mons[i].Anim == TEXT("hidden") || Mons[i].Anim == TEXT("faint")) continue;
		SleepTimer[i] -= Dt;
		if (SleepTimer[i] <= 0.f)
		{
			SleepTimer[i] = 1.1f;
			AddPopup(i, TEXT("Z"), StageHex(TEXT("BFD6FF")));
		}
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
	else if (M.Anim == TEXT("cast"))
	{
		const float P = FMath::Clamp(T / 0.4f, 0.f, 1.f);
		Offset += Toward * FMath::Sin(P * PI) * 25.f + FVector(0, 0, FMath::Sin(P * PI) * 22.f);
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
		// Drawn into the open ball by its red light: glows, shrinks and flies up into it.
		const float P = FMath::Clamp(T / 0.45f, 0.f, 1.f);
		const float Pull = P * P;
		Scale = FMath::Max(0.01f, 1.f - Pull);
		Offset = FMath::Lerp(Offset, CaptureTo - M.Home, Pull);
		Flash = 1.f;
	}
	const bool bGone = M.Anim == TEXT("hidden") || (M.Anim == TEXT("faint") && T >= 0.75f) || (M.Anim == TEXT("capture") && T >= 0.45f);
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
	// The throw, step by step (seconds): wind-up behind the trainer, a spinning arc with a trail, a bump off the Pokémon,
	// the lid opens and its red light draws the Pokémon in, the lid shuts, the ball drops and bounces, wobbles once per
	// shake with its button blinking, then clicks shut with stars — or bursts open and the Pokémon is out again.
	const float Was = BallTime;
	BallTime += Dt;
	const float Now = BallTime;
	auto Reached = [Was, Now](float At) { return Was < At && Now >= At; };
	constexpr float WindUp = 0.22f, Flight = 0.95f, Bump = 1.2f, Opened = 1.32f, Shut = 1.8f, Drop = 1.95f, Land = 2.35f, Still = 2.8f;
	constexpr float ShakeEvery = 1.0f, ShakeFor = 0.6f, LidSpeed = 0.12f, LidOpen = 105.f;
	const float Decide = Still + BallShakes * ShakeEvery + 0.15f;
	const float Done = Decide + (bBallCaught ? 1.0f : 0.45f);

	const FVector Up(0.f, 0.f, 1.f);
	const float FaceYaw = (-Forward).Rotation().Yaw;  // the button looks back at the trainer and the camera
	const FVector Hand = (Trainer ? Trainer->GetActorLocation() : Mons[0].Home) + Right * 30.f + Up * 60.f;
	const FVector Cocked = Hand - Forward * 35.f + Up * 45.f;
	const FVector Hover = Mons[1].Home - Forward * 75.f + Up * (FxHeight(1) * 0.6f + 40.f);
	const FVector Ground = Mons[1].Home - Forward * 75.f + Up * (BallR + 1.f);
	CaptureTo = Hover;

	FVector Pos = Hover;
	float Spin = 0.f;   // pitch: rolling forward in flight
	float Tilt = 0.f;   // roll: the wobble
	float Lid = 0.f;    // lid angle
	float Size = 1.f;
	if (Now < WindUp)
	{
		const float P = Now / WindUp;
		const float S = P * P * (3.f - 2.f * P);
		Pos = FMath::Lerp(Hand, Cocked, S);
		Size = 0.4f + 0.6f * S;
		Spin = 40.f * S;
	}
	else if (Now < Flight)
	{
		const float P = (Now - WindUp) / (Flight - WindUp);
		Pos = FMath::Lerp(Cocked, Hover, P) + Up * FMath::Sin(P * PI) * 230.f;
		Spin = 40.f - 760.f * P;
		BallTrailClock -= Dt;
		if (BallTrailClock <= 0.f && Fx)
		{
			BallTrailClock = 0.03f;
			Fx->BallTrail(Pos);
		}
	}
	else if (Now < Opened)
	{
		// bumps off the Pokémon, back towards the trainer and up, and comes to rest facing the camera
		const float P = (Now - Flight) / (Opened - Flight);
		Pos = Hover + (-Forward * 45.f + Up * 30.f) * FMath::Sin(P * PI) * (1.f - 0.5f * P);
		Spin = -720.f;  // two whole turns: upright again
		Lid = Now >= Bump ? LidOpen * FMath::Clamp((Now - Bump) / LidSpeed, 0.f, 1.f) : 0.f;
	}
	else if (Now < Drop)
	{
		Pos = Hover + Up * FMath::Sin((Now - Opened) * 6.f) * 4.f;
		Lid = Now < Shut ? LidOpen : LidOpen * (1.f - FMath::Clamp((Now - Shut) / LidSpeed, 0.f, 1.f));
	}
	else if (Now < Land)
	{
		const float P = (Now - Drop) / (Land - Drop);
		Pos = FMath::Lerp(Hover, Ground, P * P);
		Spin = 25.f * P;
	}
	else if (Now < Still)
	{
		// two bounces, the second smaller
		const float L = Now - Land;
		const float First = 0.26f;
		const float H = L < First ? 26.f * FMath::Sin(L / First * PI) : 8.f * FMath::Sin(FMath::Min((L - First) / (Still - Land - First), 1.f) * PI);
		Pos = Ground + Up * H;
		Spin = 25.f * (1.f - FMath::Clamp(L / (Still - Land), 0.f, 1.f));
	}
	else
	{
		Pos = Ground;
		const float Into = Now - Still;
		const int32 Wobble = FMath::FloorToInt(Into / ShakeEvery);
		const float U = (Into - Wobble * ShakeEvery) / ShakeFor;
		const bool bShaking = Wobble < BallShakes && U < 1.f && Now < Decide;
		if (bShaking)
		{
			// tips one way, the other way, and settles; each shake a bit weaker than the last
			Tilt = FMath::Sin(U * 2.f * PI) * (30.f - 6.f * Wobble) * (1.f - U * 0.35f);
			Pos += Right * FMath::Sin(U * 2.f * PI) * 2.5f;
		}
		if (BallButton)
		{
			const bool bBlink = bShaking && FMath::Fmod(U * 4.f, 1.f) < 0.5f;
			const TCHAR* Color = Now >= Decide ? (bBallCaught ? TEXT("9A9A9A") : TEXT("FAFAFA")) : bBlink ? TEXT("FF4636") : TEXT("FAFAFA");
			BallButton->SetVectorParameterValue(TEXT("Color"), StageHex(Color));
		}
		if (Now >= Decide)
		{
			const float After = Now - Decide;
			if (bBallCaught)
			{
				Size = 1.f + 0.18f * FMath::Sin(FMath::Clamp(After / 0.18f, 0.f, 1.f) * PI);  // the click
			}
			else
			{
				Lid = LidOpen * 1.15f * FMath::Clamp(After / 0.07f, 0.f, 1.f);
				Size = FMath::Max(0.01f, 1.f - After / 0.35f);
				Pos += Up * 12.f * FMath::Clamp(After / 0.1f, 0.f, 1.f);
			}
		}
	}

	if (Reached(Bump))
	{
		Animate(1, TEXT("capture"));
		UpdateAura(1);
		if (Fx)
		{
			Fx->BallOpen(Hover, FxHeight(1) * 0.55f);
			Fx->CaptureBeam(Hover, Mons[1].Home + Up * FxHeight(1) * 0.45f, FxHeight(1));
		}
	}
	if (Reached(Shut + LidSpeed) && Fx) Fx->BallTrail(Hover);
	if (Reached(Land) && Fx) Fx->BallDust(Ground - Up * BallR);
	if (Reached(Decide))
	{
		if (bBallCaught)
		{
			if (Fx) Fx->CaptureSparkles(Ground + Up * 15.f);
		}
		else
		{
			Animate(1, TEXT("appear"));
			UpdateAura(1);
			if (Fx) Fx->BallOpen(Ground + Up * 20.f, FxHeight(1));
		}
	}

	Ball->SetWorldLocation(Pos);
	Ball->SetWorldRotation(FRotator(Spin, FaceYaw, Tilt));
	Ball->SetWorldScale3D(FVector(Size));
	BallHinge->SetRelativeRotation(FRotator(Lid, 0.f, 0.f));
	if (Now >= Done)
	{
		bBallActive = false;
		if (!bBallCaught) Ball->SetVisibility(false, true);
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
	if (Fx) Fx->SetLifeSpan(0.8f);
	SetLifeSpan(0.8f);
}
