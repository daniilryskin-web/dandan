#include "LigaBattleFx.h"

#include "Components/PointLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "LigaAssets.h"
#include "LigaData.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"

namespace
{
	FLinearColor Col(float R, float G, float B) { return FLinearColor(R, G, B, 1.f); }
	float Rf(float A, float B) { return FMath::FRandRange(A, B); }
	FVector Jit(float R) { return FMath::VRand() * FMath::FRandRange(0.f, R); }
	FVector JitXY(float R)
	{
		const FVector2D P = FMath::RandPointInCircle(R);
		return FVector(P.X, P.Y, 0.f);
	}
	float SizeK(float Height) { return FMath::Clamp(Height / 120.f, 0.6f, 2.2f); }

	/** Bright inner colour, outer colour and glow of each type's effects. */
	void Palette(EPokeType T, FLinearColor& Core, FLinearColor& Edge, float& Glow)
	{
		Glow = 4.f;
		switch (T)
		{
		case EPokeType::Fire: Core = Col(1.f, 0.85f, 0.35f); Edge = Col(1.f, 0.28f, 0.05f); Glow = 6.f; break;
		case EPokeType::Water: Core = Col(0.7f, 0.9f, 1.f); Edge = Col(0.1f, 0.42f, 1.f); Glow = 2.5f; break;
		case EPokeType::Electric: Core = Col(1.f, 1.f, 0.7f); Edge = Col(1.f, 0.85f, 0.1f); Glow = 8.f; break;
		case EPokeType::Grass: Core = Col(0.65f, 1.f, 0.45f); Edge = Col(0.15f, 0.62f, 0.15f); Glow = 2.5f; break;
		case EPokeType::Ice: Core = Col(0.92f, 1.f, 1.f); Edge = Col(0.42f, 0.82f, 1.f); Glow = 4.f; break;
		case EPokeType::Fighting: Core = Col(1.f, 0.75f, 0.45f); Edge = Col(0.95f, 0.32f, 0.15f); break;
		case EPokeType::Poison: Core = Col(0.88f, 0.55f, 1.f); Edge = Col(0.5f, 0.1f, 0.62f); Glow = 2.5f; break;
		case EPokeType::Ground: Core = Col(0.92f, 0.78f, 0.5f); Edge = Col(0.55f, 0.38f, 0.18f); Glow = 1.2f; break;
		case EPokeType::Flying: Core = Col(0.97f, 0.98f, 1.f); Edge = Col(0.62f, 0.78f, 1.f); Glow = 3.f; break;
		case EPokeType::Psychic: Core = Col(1.f, 0.62f, 0.88f); Edge = Col(0.92f, 0.2f, 0.62f); Glow = 4.f; break;
		case EPokeType::Bug: Core = Col(0.85f, 1.f, 0.45f); Edge = Col(0.45f, 0.68f, 0.1f); Glow = 2.5f; break;
		case EPokeType::Rock: Core = Col(0.86f, 0.8f, 0.62f); Edge = Col(0.5f, 0.45f, 0.35f); Glow = 1.f; break;
		case EPokeType::Ghost: Core = Col(0.72f, 0.52f, 1.f); Edge = Col(0.25f, 0.1f, 0.45f); Glow = 2.f; break;
		case EPokeType::Dragon: Core = Col(0.65f, 0.62f, 1.f); Edge = Col(0.38f, 0.15f, 0.92f); Glow = 4.f; break;
		case EPokeType::Dark: Core = Col(0.5f, 0.38f, 0.6f); Edge = Col(0.1f, 0.05f, 0.15f); Glow = 1.f; break;
		case EPokeType::Steel: Core = Col(0.97f, 0.97f, 1.f); Edge = Col(0.62f, 0.67f, 0.78f); Glow = 3.f; break;
		case EPokeType::Fairy: Core = Col(1.f, 0.88f, 0.96f); Edge = Col(1.f, 0.5f, 0.78f); Glow = 4.f; break;
		default: Core = Col(1.f, 1.f, 0.95f); Edge = Col(0.9f, 0.85f, 0.72f); Glow = 4.f; break;
		}
	}

	bool OneOf(const FString& Id, std::initializer_list<const TCHAR*> Ids)
	{
		for (const TCHAR* X : Ids)
		{
			if (Id == X) return true;
		}
		return false;
	}
}

ALigaBattleFx::ALigaBattleFx()
{
	PrimaryActorTick.bCanEverTick = true;
	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	Root->SetMobility(EComponentMobility::Movable);
	RootComponent = Root;
	Light = CreateDefaultSubobject<UPointLightComponent>(TEXT("Light"));
	Light->SetupAttachment(Root);
	Light->SetMobility(EComponentMobility::Movable);
	Light->IntensityUnits = ELightUnits::Candelas;
	Light->Intensity = 0.f;
	Light->AttenuationRadius = 1600.f;
	Light->CastShadows = false;
}

int32 ALigaBattleFx::AcquireSlot()
{
	if (!PlaneMesh)
	{
		// First use: the engine's basic shapes and the effect material (M_LigaFx from the setup script).
		PlaneMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Plane.Plane"));
		SphereMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
		CubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
		ConeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cone.Cone"));
		CylinderMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
		const FString Path = FLigaAssets::Get().FxMaterial.IsEmpty() ? FString(TEXT("/Game/Liga/Materials/M_LigaFx.M_LigaFx")) : FLigaAssets::Get().FxMaterial;
		Material = LoadObject<UMaterialInterface>(nullptr, *Path, nullptr, LOAD_NoWarn | LOAD_Quiet);
		bSoft = Material != nullptr;
		if (!Material) Material = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	}
	if (FreeSlots.Num() > 0) return FreeSlots.Pop();
	if (Pool.Num() >= 400 || !PlaneMesh) return INDEX_NONE;
	UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this);
	C->SetupAttachment(Root);
	C->SetMobility(EComponentMobility::Movable);
	C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	C->SetGenerateOverlapEvents(false);
	C->SetCastShadow(false);
	C->SetStaticMesh(PlaneMesh);
	C->RegisterComponent();
	UMaterialInstanceDynamic* MI = Material ? UMaterialInstanceDynamic::Create(Material, this) : nullptr;
	if (MI) C->SetMaterial(0, MI);
	C->SetVisibility(false);
	Pool.Add(C);
	Mids.Add(MI);
	return Pool.Num() - 1;
}

void ALigaBattleFx::ReleaseSlot(int32 Slot)
{
	if (!Pool.IsValidIndex(Slot)) return;
	Pool[Slot]->SetVisibility(false);
	FreeSlots.Add(Slot);
}

UStaticMesh* ALigaBattleFx::MeshFor(ELigaFxShape Shape) const
{
	switch (Shape)
	{
	case ELigaFxShape::Disc: return bSoft ? PlaneMesh.Get() : SphereMesh.Get();
	case ELigaFxShape::Ring:
	case ELigaFxShape::FlatRing: return bSoft ? PlaneMesh.Get() : CylinderMesh.Get();
	case ELigaFxShape::Orb: return SphereMesh.Get();
	case ELigaFxShape::Cone: return ConeMesh.Get();
	default: return CubeMesh.Get();
	}
}

FLigaFxParticle& ALigaBattleFx::Add(ELigaFxShape Shape, const FVector& Pos, float Life, float Size0, float Size1, const FLinearColor& C0, const FLinearColor& C1, float Glow)
{
	FLigaFxParticle& P = Live.AddDefaulted_GetRef();
	P.Shape = Shape;
	P.Pos = Pos;
	P.Life = FMath::Max(0.05f, Life);
	P.Size0 = Size0;
	P.Size1 = Size1;
	P.Color0 = C0;
	P.Color1 = C1;
	P.Glow = Glow;
	return P;
}

void ALigaBattleFx::Emit(float Delay, float Duration, float Interval, TFunction<void(float)> Spawn)
{
	FLigaFxEmitter& E = Emitters.AddDefaulted_GetRef();
	E.Delay = Delay;
	E.Duration = FMath::Max(0.f, Duration);
	E.Interval = FMath::Max(0.005f, Interval);
	E.Spawn = MoveTemp(Spawn);
}

void ALigaBattleFx::Later(float Delay, TFunction<void()> Do)
{
	Emit(Delay, 0.f, 1.f, [Do](float) { if (Do) Do(); });
}

void ALigaBattleFx::Flash(const FVector& At, const FLinearColor& Color, float Strength)
{
	Light->SetWorldLocation(At);
	Light->SetLightColor(Color);
	LightLevel = FMath::Max(LightLevel, Strength);
}

void ALigaBattleFx::Tick(float Dt)
{
	Super::Tick(Dt);
	// Emitters (a spawn may add new emitters, so work by index and re-read the entry after each call).
	int32 i = 0;
	while (i < Emitters.Num())
	{
		if (Emitters[i].Delay > 0.f)
		{
			Emitters[i].Delay -= Dt;
			++i;
			continue;
		}
		Emitters[i].Clock += Dt;
		while (Emitters.IsValidIndex(i) && Emitters[i].Next <= Emitters[i].Clock && Emitters[i].Next <= Emitters[i].Duration + KINDA_SMALL_NUMBER)
		{
			const float Progress = Emitters[i].Duration > 0.f ? Emitters[i].Next / Emitters[i].Duration : 1.f;
			Emitters[i].Next += Emitters[i].Interval;
			TFunction<void(float)> F = Emitters[i].Spawn;
			if (F) F(Progress);
		}
		if (Emitters[i].Clock > Emitters[i].Duration)
		{
			Emitters.RemoveAt(i);
			continue;
		}
		++i;
	}
	for (int32 a = 0; a < 2; ++a) TickAura(a, Dt);
	for (int32 p = Live.Num() - 1; p >= 0; --p)
	{
		if (!UpdateParticle(Live[p], Dt))
		{
			ReleaseSlot(Live[p].Slot);
			Live.RemoveAtSwap(p);
		}
	}
	LightLevel = FMath::Max(0.f, LightLevel - Dt * 4.f);
	Light->SetIntensity(LightLevel * 1500.f);
}

bool ALigaBattleFx::UpdateParticle(FLigaFxParticle& P, float Dt)
{
	if (P.Delay > 0.f)
	{
		P.Delay -= Dt;
		if (P.Delay > 0.f) return true;
	}
	P.Age += Dt;
	if (P.Age >= P.Life) return false;
	if (P.Slot == INDEX_NONE)
	{
		P.Slot = AcquireSlot();
		if (P.Slot == INDEX_NONE) return false;
		UStaticMeshComponent* C = Pool[P.Slot];
		UStaticMesh* Mesh = MeshFor(P.Shape);
		if (Mesh && C->GetStaticMesh() != Mesh) C->SetStaticMesh(Mesh);
		if (UMaterialInstanceDynamic* MI = Mids[P.Slot])
		{
			const float ShapeParam = P.Shape == ELigaFxShape::Disc ? 1.f : (P.Shape == ELigaFxShape::Ring || P.Shape == ELigaFxShape::FlatRing) ? 2.f : P.Shape == ELigaFxShape::Orb ? 3.f : 0.f;
			MI->SetScalarParameterValue(TEXT("Shape"), ShapeParam);
		}
	}
	if (P.bOrbit)
	{
		P.OrbitAngle += P.OrbitSpeed * Dt;
		P.OrbitCenter.Z += P.OrbitRise * Dt;
		P.Pos = P.OrbitCenter + FVector(FMath::Cos(P.OrbitAngle) * P.OrbitRadius, FMath::Sin(P.OrbitAngle) * P.OrbitRadius, 0.f);
	}
	else
	{
		P.Vel += P.Accel * Dt;
		if (P.Drag > 0.f) P.Vel *= FMath::Max(0.f, 1.f - P.Drag * Dt);
		P.Pos += P.Vel * Dt;
	}
	P.Rot += P.Spin * Dt;
	const float T = P.Age / P.Life;
	const float In = FMath::Min(1.f, P.Age / 0.06f);
	const float Out = T < 0.6f ? 1.f : FMath::Max(0.f, 1.f - (T - 0.6f) / 0.4f);
	const float Alpha = In * Out * P.Opacity;
	float Size = FMath::Lerp(P.Size0, P.Size1, T);
	if (!bSoft) Size *= FMath::Max(0.05f, In * Out);  // opaque fallback: fade by shrinking
	FVector Loc = P.Pos;
	FRotator Rot = P.Rot;
	FVector Scale(Size / 100.f);
	const FVector ToCam = (ViewPos - P.Pos).GetSafeNormal();
	switch (P.Shape)
	{
	case ELigaFxShape::Disc:
	case ELigaFxShape::Ring:
		Rot = FRotationMatrix::MakeFromZ(ToCam.IsNearlyZero() ? FVector::UpVector : ToCam).Rotator();
		if (!bSoft && P.Shape == ELigaFxShape::Ring) Scale.Z *= 0.04f;
		break;
	case ELigaFxShape::FlatRing:
		Rot = FRotator::ZeroRotator;
		if (!bSoft) Scale.Z *= 0.04f;
		break;
	case ELigaFxShape::Orb:
		break;
	case ELigaFxShape::Cube:
	case ELigaFxShape::Cone:
		if (P.bAlignToVelocity && !P.Vel.IsNearlyZero())
		{
			Rot = P.Shape == ELigaFxShape::Cone ? FRotationMatrix::MakeFromZ(P.Vel.GetSafeNormal()).Rotator() : P.Vel.Rotation();
		}
		Scale *= P.Stretch;
		break;
	case ELigaFxShape::Beam:
	{
		const FVector D = P.BeamEnd - P.Pos;
		Loc = (P.Pos + P.BeamEnd) * 0.5f;
		Rot = D.IsNearlyZero() ? FRotator::ZeroRotator : D.Rotation();
		Scale = FVector(FMath::Max(1.0, D.Size()) / 100.0, Size / 100.f * P.Stretch.Y, Size / 100.f * P.Stretch.Z);
		break;
	}
	}
	UStaticMeshComponent* C = Pool[P.Slot];
	C->SetWorldLocationAndRotation(Loc, Rot);
	C->SetWorldScale3D(Scale);
	if (!C->IsVisible()) C->SetVisibility(true);
	if (UMaterialInstanceDynamic* MI = Mids[P.Slot])
	{
		const FLinearColor Color = FMath::Lerp(P.Color0, P.Color1, T);
		MI->SetVectorParameterValue(TEXT("Color"), Color);
		MI->SetScalarParameterValue(TEXT("Alpha"), Alpha);
		MI->SetScalarParameterValue(TEXT("Glow"), P.Glow);
	}
	return true;
}

// ——— building blocks ———

void ALigaBattleFx::Burst(const FVector& At, float K, const FLinearColor& Core, const FLinearColor& Edge, int32 Sparks, float Glow)
{
	Add(ELigaFxShape::Disc, At, 0.22f, 30.f * K, 150.f * K, Core, Edge, Glow * 1.5f);
	{
		FLigaFxParticle& R = Add(ELigaFxShape::Ring, At, 0.32f, 20.f * K, 190.f * K, Core, Edge, Glow);
		R.Opacity = 0.8f;
	}
	for (int32 i = 0; i < Sparks; ++i)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, At + Jit(10.f * K), Rf(0.3f, 0.5f), 16.f * K, 3.f * K, Core, Edge, Glow);
		P.Vel = FMath::VRand() * Rf(250.f, 600.f) * K;
		P.Drag = 3.5f;
	}
	Flash(At, Edge, 0.8f);
}

void ALigaBattleFx::Stream(const FVector& From, const FVector& To, float Travel, float Duration, float K, const FLinearColor& Core, const FLinearColor& Edge,
	float Spread, float Glow, ELigaFxShape Shape)
{
	Emit(0.f, Duration, 0.022f, [=, this](float)
	{
		const FVector Off = Jit(Spread * K);
		const float Life = Travel * Rf(1.0f, 1.2f);
		FLigaFxParticle& P = Add(Shape, From + Off * 0.3f, Life, 14.f * K, 48.f * K, Core, Edge, Glow);
		P.Vel = (To + Off - From) / Travel;
		if (Shape == ELigaFxShape::Orb) P.Opacity = 0.8f;
	});
	Flash(From, Edge, 0.5f);
}

void ALigaBattleFx::Bolt(const FVector& From, const FVector& To, float K, const FLinearColor& Color, int32 Segments, float Delay)
{
	Later(Delay, [=, this]()
	{
		const FVector Dir = To - From;
		FVector Side = FVector::CrossProduct(Dir.GetSafeNormal(), FVector::UpVector).GetSafeNormal();
		if (Side.IsNearlyZero()) Side = FVector::RightVector;
		const FVector Up = FVector::CrossProduct(Side, Dir.GetSafeNormal()).GetSafeNormal();
		FVector Prev = From;
		const int32 N = FMath::Max(2, Segments);
		for (int32 i = 1; i <= N; ++i)
		{
			FVector Pt = From + Dir * (float(i) / N);
			if (i < N) Pt += Side * Rf(-1.f, 1.f) * 42.f * K + Up * Rf(-1.f, 1.f) * 30.f * K;
			FLigaFxParticle& B = Add(ELigaFxShape::Beam, Prev, 0.17f, 10.f * K, 5.f * K, Col(1.f, 1.f, 0.9f), Color, 9.f);
			B.BeamEnd = Pt;
			Prev = Pt;
		}
		Add(ELigaFxShape::Disc, To, 0.2f, 40.f * K, 120.f * K, Col(1.f, 1.f, 0.85f), Color, 8.f);
		Flash(To, Color, 1.f);
	});
}

void ALigaBattleFx::Lob(const FVector& From, const FVector& To, float Travel, int32 Count, float K, const FLinearColor& Core, const FLinearColor& Edge, ELigaFxShape Shape, float Glow)
{
	const FVector G(0.f, 0.f, -900.f);
	for (int32 i = 0; i < Count; ++i)
	{
		const FVector Target = To + Jit(25.f * K);
		FLigaFxParticle& P = Add(Shape, From, Travel + 0.06f, 20.f * K, 28.f * K, Core, Edge, Glow);
		P.Delay = i * 0.07f;
		P.Vel = (Target - From) / Travel - G * (0.5f * Travel);
		P.Accel = G;
		P.Opacity = 0.9f;
	}
}

void ALigaBattleFx::Swirl(const FVector& Center, float Radius, float K, const FLinearColor& Core, const FLinearColor& Edge, int32 Count, float Duration, ELigaFxShape Shape, float Glow)
{
	for (int32 i = 0; i < Count; ++i)
	{
		FLigaFxParticle& P = Add(Shape, Center, Duration, 20.f * K, 10.f * K, Core, Edge, Glow);
		P.bOrbit = true;
		P.OrbitCenter = Center - FVector(0.f, 0.f, Radius * 0.7f) + FVector(0.f, 0.f, Rf(0.f, Radius * 0.5f));
		P.OrbitRadius = Radius * Rf(0.75f, 1.1f);
		P.OrbitSpeed = Rf(7.f, 10.f);
		P.OrbitAngle = Rf(0.f, 2.f * PI);
		P.OrbitRise = Radius * 1.3f / FMath::Max(0.1f, Duration);
		P.Delay = Rf(0.f, 0.15f);
	}
}

void ALigaBattleFx::Rings(const FVector& From, const FVector& To, float K, const FLinearColor& Color, int32 Count, float Duration)
{
	Emit(0.f, Duration, Duration / FMath::Max(1, Count), [=, this](float)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Ring, From, 0.45f, 30.f * K, 120.f * K, Color, Color, 3.f);
		P.Vel = (To - From) / 0.45f;
	});
}

void ALigaBattleFx::Powder(const FVector& Base, float Height, const FLinearColor& Color)
{
	const float K = SizeK(Height);
	Emit(0.f, 0.55f, 0.02f, [=, this](float)
	{
		const FVector P0 = Base + JitXY(Height * 0.55f) + FVector(0.f, 0.f, Height * Rf(1.f, 1.45f));
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, P0, Rf(0.6f, 0.9f), 11.f * K, 6.f * K, Color, Color, 3.f);
		P.Vel = FVector(Rf(-20.f, 20.f), Rf(-20.f, 20.f), -Height * Rf(0.9f, 1.3f));
	});
}

void ALigaBattleFx::Leaves(const FVector& From, const FVector& To, float K, int32 Count)
{
	for (int32 i = 0; i < Count; ++i)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Cube, From + Jit(20.f * K), 0.5f, 22.f * K, 22.f * K, Col(0.45f, 0.88f, 0.3f), Col(0.2f, 0.62f, 0.15f), 1.6f);
		P.Stretch = FVector(1.f, 0.5f, 0.06f);
		P.Delay = i * 0.05f;
		P.Vel = (To + Jit(30.f * K) - From) / 0.45f;
		P.Rot = FRotator(Rf(0.f, 360.f), Rf(0.f, 360.f), Rf(0.f, 360.f));
		P.Spin = FRotator(Rf(-900.f, 900.f), Rf(-900.f, 900.f), 0.f);
	}
}

void ALigaBattleFx::RocksFall(const FVector& Base, float Height, float K, const FLinearColor& Color, int32 Count)
{
	for (int32 i = 0; i < Count; ++i)
	{
		const float S = 30.f * K * Rf(0.7f, 1.3f);
		FLigaFxParticle& P = Add(ELigaFxShape::Cube, Base + JitXY(60.f * K) + FVector(0.f, 0.f, Height + 380.f * K), 0.55f, S, S, Color, Color * 0.75f, 0.5f);
		P.Delay = i * 0.07f;
		P.Accel = FVector(0.f, 0.f, -2400.f);
		P.Vel = FVector(0.f, 0.f, -300.f);
		P.Rot = FRotator(Rf(0.f, 360.f), Rf(0.f, 360.f), Rf(0.f, 360.f));
		P.Spin = FRotator(Rf(-300.f, 300.f), Rf(-300.f, 300.f), 0.f);
	}
}

void ALigaBattleFx::Erupt(const FVector& Base, float K, const FLinearColor& Color)
{
	{
		FLigaFxParticle& R = Add(ELigaFxShape::FlatRing, Base + FVector(0.f, 0.f, 6.f), 0.5f, 30.f * K, 280.f * K, Color, Color, 1.5f);
		R.Opacity = 0.9f;
	}
	for (int32 i = 0; i < 12; ++i)
	{
		const float S = 16.f * K * Rf(0.7f, 1.4f);
		FLigaFxParticle& P = Add(ELigaFxShape::Cube, Base + JitXY(45.f * K), 0.8f, S, S, Color, Color * 0.6f, 0.5f);
		P.Vel = FVector(Rf(-150.f, 150.f), Rf(-150.f, 150.f), Rf(450.f, 800.f)) * K;
		P.Accel = FVector(0.f, 0.f, -1800.f);
		P.Rot = FRotator(Rf(0.f, 360.f), Rf(0.f, 360.f), 0.f);
		P.Spin = FRotator(Rf(-400.f, 400.f), Rf(-400.f, 400.f), 0.f);
	}
	for (int32 i = 0; i < 8; ++i)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, Base + JitXY(50.f * K) + FVector(0.f, 0.f, 20.f * K), 0.75f, 30.f * K, 95.f * K, Color, Color * 0.5f, 0.8f);
		P.Vel = FVector(0.f, 0.f, Rf(30.f, 90.f));
		P.Opacity = 0.75f;
	}
}

void ALigaBattleFx::Ray(const FVector& From, const FVector& To, float K, const FLinearColor& Core, const FLinearColor& Edge, float Duration)
{
	{
		FLigaFxParticle& A = Add(ELigaFxShape::Beam, From, Duration, 36.f * K, 12.f * K, Edge, Edge, 4.f);
		A.BeamEnd = To;
		A.Opacity = 0.7f;
	}
	{
		FLigaFxParticle& B = Add(ELigaFxShape::Beam, From, Duration, 14.f * K, 4.f * K, Core, Core, 9.f);
		B.BeamEnd = To;
	}
	Emit(0.f, Duration, 0.035f, [=, this](float)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, FMath::Lerp(From, To, Rf(0.f, 1.f)) + Jit(16.f * K), 0.25f, 16.f * K, 4.f * K, Core, Edge, 6.f);
		P.Vel = Jit(80.f);
	});
	Flash(From, Edge, 0.7f);
}

void ALigaBattleFx::Aura(const FVector& Base, float Height, const FLinearColor& Color)
{
	const float K = SizeK(Height);
	for (int32 i = 0; i < 3; ++i)
	{
		FLigaFxParticle& R = Add(ELigaFxShape::FlatRing, Base + FVector(0.f, 0.f, 5.f), 0.7f, 40.f * K, 160.f * K, Color, Color, 3.f);
		R.Delay = i * 0.15f;
		R.Vel = FVector(0.f, 0.f, Height * 0.8f);
	}
	Emit(0.f, 0.6f, 0.03f, [=, this](float)
	{
		const float A = Rf(0.f, 2.f * PI);
		const FVector P0 = Base + FVector(FMath::Cos(A) * Height * 0.45f, FMath::Sin(A) * Height * 0.45f, Rf(0.f, Height * 0.3f));
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, P0, 0.6f, 14.f * K, 4.f * K, Color, Color, 4.f);
		P.Vel = FVector(0.f, 0.f, Height * 1.2f);
	});
	Flash(Base + FVector(0.f, 0.f, Height * 0.5f), Color, 0.5f);
}

// ——— moves ———

float ALigaBattleFx::PlayMove(const FLigaMove& Move, const FVector& From, float FromH, const FVector& To, float ToH)
{
	const FVector Dir = (To - From).GetSafeNormal2D();
	const float K = (SizeK(FromH) + SizeK(ToH)) * 0.5f;
	const float KT = SizeK(ToH);
	const FVector Mouth = From + FVector(0.f, 0.f, FromH * 0.5f) + Dir * FromH * 0.22f;
	const FVector Hit = To + FVector(0.f, 0.f, ToH * 0.42f);
	FLinearColor Core, Edge;
	float Glow = 4.f;
	Palette(Move.Type, Core, Edge, Glow);
	const FString& Id = Move.Id;

	// ——— well-known moves ———
	if (Id == TEXT("ember"))
	{
		for (int32 i = 0; i < 3; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Orb, Mouth, 0.42f, 24.f * K, 30.f * K, Core, Edge, 6.f);
			P.Delay = i * 0.09f;
			P.Vel = (Hit + Jit(20.f * K) - Mouth) / 0.4f;
		}
		Stream(Mouth, Hit, 0.4f, 0.32f, K * 0.7f, Core, Edge, 10.f, 5.f);
		return 0.6f;
	}
	if (OneOf(Id, {TEXT("flamethrower"), TEXT("fire-blast"), TEXT("dragon-breath"), TEXT("dragon-rage"), TEXT("heat-wave"), TEXT("inferno")}))
	{
		Stream(Mouth, Hit, 0.36f, 0.55f, K * (Id == TEXT("fire-blast") ? 1.5f : 1.15f), Core, Edge, 18.f, Glow);
		return 0.55f;
	}
	if (OneOf(Id, {TEXT("fire-spin"), TEXT("twister"), TEXT("whirlpool"), TEXT("sand-tomb")}))
	{
		Stream(Mouth, Hit, 0.3f, 0.2f, K * 0.8f, Core, Edge, 10.f, Glow);
		const FVector C = Hit;
		const float R = ToH * 0.55f;
		Later(0.25f, [=, this]() { Swirl(C, R, KT, Core, Edge, 28, 0.9f, ELigaFxShape::Disc, Glow); });
		return 0.45f;
	}
	if (OneOf(Id, {TEXT("water-gun"), TEXT("hydro-pump"), TEXT("water-pulse"), TEXT("brine"), TEXT("scald")}))
	{
		Stream(Mouth, Hit, 0.34f, 0.5f, K * (Id == TEXT("hydro-pump") ? 1.6f : 1.f), Core, Edge, 8.f, 2.5f, ELigaFxShape::Orb);
		return 0.5f;
	}
	if (OneOf(Id, {TEXT("bubble"), TEXT("bubble-beam")}))
	{
		const int32 N = Id == TEXT("bubble") ? 8 : 14;
		for (int32 i = 0; i < N; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Orb, Mouth + Jit(10.f * K), 0.62f, 12.f * K * Rf(0.7f, 1.4f), 18.f * K, Col(0.8f, 0.94f, 1.f), Col(0.5f, 0.8f, 1.f), 1.4f);
			P.Opacity = 0.6f;
			P.Delay = i * 0.04f;
			P.Vel = (Hit + Jit(30.f * K) - Mouth) / 0.58f;
		}
		return 0.65f;
	}
	if (Id == TEXT("surf"))
	{
		Erupt(To, KT * 1.2f, Edge);
		Lob(From + Dir * 60.f, Hit, 0.45f, 10, K, Core, Edge, ELigaFxShape::Orb, 2.f);
		return 0.5f;
	}
	if (OneOf(Id, {TEXT("thunder-shock"), TEXT("thunderbolt"), TEXT("discharge"), TEXT("shock-wave"), TEXT("charge-beam")}))
	{
		const float S = Id == TEXT("thunder-shock") ? 1.f : 1.4f;
		for (int32 i = 0; i < 3; ++i) Bolt(Mouth, Hit, K * S, Edge, 7, i * 0.08f);
		return 0.3f;
	}
	if (Id == TEXT("thunder"))
	{
		for (int32 i = 0; i < 3; ++i) Bolt(Hit + FVector(0.f, 0.f, 900.f) + JitXY(60.f), Hit, KT * 1.6f, Edge, 9, i * 0.08f);
		return 0.35f;
	}
	if (Id == TEXT("thunder-wave"))
	{
		for (int32 i = 0; i < 2; ++i) Bolt(Mouth, Hit, K * 0.7f, Edge, 6, i * 0.12f);
		return 0.55f;
	}
	if (Id == TEXT("vine-whip"))
	{
		for (int32 i = 0; i < 2; ++i)
		{
			FLigaFxParticle& V = Add(ELigaFxShape::Beam, Mouth, 0.3f, 9.f * K, 7.f * K, Col(0.35f, 0.75f, 0.25f), Col(0.2f, 0.55f, 0.15f), 1.2f);
			V.BeamEnd = Hit + Jit(25.f * K);
			V.Delay = i * 0.08f;
		}
		return 0.3f;
	}
	if (OneOf(Id, {TEXT("razor-leaf"), TEXT("magical-leaf"), TEXT("leaf-storm"), TEXT("leaf-blade")}))
	{
		Leaves(Mouth, Hit, K, 9);
		return 0.5f;
	}
	if (OneOf(Id, {TEXT("absorb"), TEXT("mega-drain"), TEXT("giga-drain"), TEXT("leech-life"), TEXT("drain-punch"), TEXT("draining-kiss")}))
	{
		const FVector UserMid = From + FVector(0.f, 0.f, FromH * 0.45f);
		const FLinearColor G = Move.Type == EPokeType::Grass ? Col(0.6f, 1.f, 0.5f) : Core;
		Emit(0.3f, 0.6f, 0.035f, [=, this](float)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Disc, Hit + Jit(30.f * K), 0.5f, 15.f * K, 8.f * K, G, G, 5.f);
			P.Vel = (UserMid - Hit) / 0.5f + Jit(60.f);
		});
		return 0.3f;
	}
	if (Id == TEXT("leech-seed"))
	{
		Lob(Mouth, Hit, 0.45f, 3, K * 0.6f, Col(0.55f, 0.45f, 0.25f), Col(0.4f, 0.6f, 0.2f), ELigaFxShape::Orb, 1.f);
		return 0.6f;
	}
	if (Id == TEXT("sleep-powder") || Id == TEXT("spore"))
	{
		Powder(To, ToH, Col(0.55f, 0.85f, 1.f));
		return 0.75f;
	}
	if (Id == TEXT("poison-powder"))
	{
		Powder(To, ToH, Col(0.78f, 0.38f, 0.98f));
		return 0.75f;
	}
	if (Id == TEXT("stun-spore"))
	{
		Powder(To, ToH, Col(1.f, 0.9f, 0.3f));
		return 0.75f;
	}
	if (Id == TEXT("string-shot"))
	{
		for (int32 i = 0; i < 3; ++i)
		{
			FLigaFxParticle& S = Add(ELigaFxShape::Beam, Mouth, 0.6f, 4.f * K, 4.f * K, Col(1.f, 1.f, 1.f), Col(0.9f, 0.9f, 0.9f), 2.f);
			S.BeamEnd = Hit + Jit(35.f * K);
			S.Delay = i * 0.07f;
		}
		return 0.55f;
	}
	if (OneOf(Id, {TEXT("sand-attack"), TEXT("mud-slap"), TEXT("mud-shot")}))
	{
		const FLinearColor Sand = Id == TEXT("sand-attack") ? Col(0.92f, 0.82f, 0.55f) : Col(0.5f, 0.36f, 0.2f);
		Lob(From + Dir * 40.f + FVector(0.f, 0.f, 20.f), Hit, 0.42f, 10, K * 0.8f, Sand, Sand * 0.8f, ELigaFxShape::Disc, 0.9f);
		return 0.5f;
	}
	if (OneOf(Id, {TEXT("smokescreen"), TEXT("smog"), TEXT("poison-gas"), TEXT("haze")}))
	{
		const FLinearColor Smoke = Id == TEXT("smokescreen") ? Col(0.35f, 0.35f, 0.38f) : Col(0.45f, 0.25f, 0.5f);
		Stream(Mouth, Hit, 0.45f, 0.5f, K * 1.3f, Smoke, Smoke * 0.6f, 25.f, 0.6f);
		return 0.6f;
	}
	if (OneOf(Id, {TEXT("gust"), TEXT("whirlwind"), TEXT("air-cutter"), TEXT("hurricane")}))
	{
		Rings(Mouth, Hit, K, Col(0.9f, 0.95f, 1.f), 3, 0.25f);
		const FVector C = Hit;
		const float R = ToH * 0.6f;
		Later(0.2f, [=, this]() { Swirl(C, R, KT, Col(1.f, 1.f, 1.f), Col(0.65f, 0.8f, 1.f), 24, 0.7f, ELigaFxShape::Disc, 3.f); });
		return 0.45f;
	}
	if (OneOf(Id, {TEXT("confusion"), TEXT("psychic"), TEXT("psyshock"), TEXT("extrasensory")}))
	{
		for (int32 i = 0; i < 4; ++i)
		{
			FLigaFxParticle& R = Add(ELigaFxShape::Ring, Hit, 0.4f, 170.f * KT, 20.f * KT, Core, Edge, 4.f);
			R.Delay = 0.1f + i * 0.1f;
		}
		Aura(From, FromH, Edge);
		return 0.55f;
	}
	if (OneOf(Id, {TEXT("psybeam"), TEXT("hypnosis"), TEXT("psywave")}))
	{
		Rings(Mouth, Hit, K, Id == TEXT("hypnosis") ? Col(0.72f, 0.5f, 1.f) : Edge, 6, 0.45f);
		return Id == TEXT("hypnosis") ? 0.75f : 0.5f;
	}
	if (OneOf(Id, {TEXT("growl"), TEXT("roar"), TEXT("supersonic"), TEXT("sing"), TEXT("screech"), TEXT("disarming-voice"), TEXT("bug-buzz"), TEXT("hyper-voice"), TEXT("uproar")}))
	{
		FLinearColor C = Col(1.f, 0.75f, 0.35f);
		if (Id == TEXT("supersonic")) C = Col(0.6f, 0.85f, 1.f);
		else if (Id == TEXT("sing") || Id == TEXT("disarming-voice")) C = Col(1.f, 0.6f, 0.85f);
		else if (Id == TEXT("screech")) C = Col(1.f, 0.35f, 0.35f);
		else if (Id == TEXT("bug-buzz")) C = Core;
		Rings(Mouth, Hit, K, C, 5, 0.45f);
		return 0.6f;
	}
	if (OneOf(Id, {TEXT("leer"), TEXT("scary-face"), TEXT("glare"), TEXT("mean-look")}))
	{
		const FVector Side = FVector::CrossProduct(Dir, FVector::UpVector);
		for (int32 s = -1; s <= 1; s += 2)
		{
			Add(ELigaFxShape::Disc, Mouth + FVector(0.f, 0.f, 12.f * K) + Side * (9.f * K * s), 0.35f, 8.f * K, 45.f * K, Col(1.f, 0.3f, 0.25f), Col(1.f, 0.1f, 0.1f), 7.f);
		}
		const FVector H = Hit;
		Later(0.25f, [=, this]() { Add(ELigaFxShape::Ring, H, 0.35f, 40.f * KT, 150.f * KT, Col(1.f, 0.3f, 0.3f), Col(0.8f, 0.1f, 0.1f), 4.f); });
		return 0.6f;
	}
	if (OneOf(Id, {TEXT("tail-whip"), TEXT("charm"), TEXT("sweet-kiss"), TEXT("baby-doll-eyes")}))
	{
		for (int32 i = 0; i < 8; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Disc, Mouth + Jit(40.f * K), 0.5f, 6.f * K, 22.f * K, Col(1.f, 0.85f, 0.95f), Col(1.f, 0.5f, 0.75f), 5.f);
			P.Delay = i * 0.04f;
			P.Vel = FVector(0.f, 0.f, 60.f);
		}
		return 0.5f;
	}
	if (OneOf(Id, {TEXT("harden"), TEXT("withdraw"), TEXT("defense-curl"), TEXT("iron-defense"), TEXT("barrier"), TEXT("acid-armor"), TEXT("reflect"), TEXT("light-screen")}))
	{
		Aura(From, FromH, Col(0.6f, 0.8f, 1.f));
		return 0.65f;
	}
	if (OneOf(Id, {TEXT("recover"), TEXT("rest"), TEXT("synthesis"), TEXT("moonlight"), TEXT("morning-sun"), TEXT("roost"), TEXT("soft-boiled"), TEXT("milk-drink")}))
	{
		Aura(From, FromH, Col(0.5f, 1.f, 0.6f));
		return 0.5f;
	}
	if (OneOf(Id, {TEXT("protect"), TEXT("detect")}))
	{
		Shield(From, FromH);
		return 0.5f;
	}
	if (Id == TEXT("swift"))
	{
		for (int32 i = 0; i < 6; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Disc, Mouth, 0.45f, 20.f * K, 16.f * K, Col(1.f, 0.98f, 0.6f), Col(1.f, 0.85f, 0.2f), 8.f);
			P.Delay = i * 0.05f;
			P.Vel = (Hit + Jit(35.f * K) - Mouth) / 0.42f;
		}
		return 0.5f;
	}
	if (OneOf(Id, {TEXT("hyper-beam"), TEXT("solar-beam"), TEXT("ice-beam"), TEXT("aurora-beam"), TEXT("signal-beam"), TEXT("flash-cannon"), TEXT("dazzling-gleam"), TEXT("dragon-pulse"), TEXT("dark-pulse")}))
	{
		Ray(Mouth, Hit, K * (Id == TEXT("hyper-beam") || Id == TEXT("solar-beam") ? 1.6f : 1.f), Core, Edge, 0.5f);
		return 0.4f;
	}
	if (OneOf(Id, {TEXT("rock-throw"), TEXT("rock-slide"), TEXT("stone-edge"), TEXT("rock-tomb"), TEXT("ancient-power")}))
	{
		RocksFall(To, ToH, KT, Col(0.62f, 0.56f, 0.45f), Id == TEXT("rock-throw") ? 3 : 6);
		return 0.55f;
	}
	if (OneOf(Id, {TEXT("earthquake"), TEXT("magnitude"), TEXT("dig"), TEXT("bulldoze"), TEXT("earth-power")}))
	{
		Erupt(To, KT, Col(0.62f, 0.45f, 0.25f));
		return 0.35f;
	}
	if (OneOf(Id, {TEXT("acid"), TEXT("sludge"), TEXT("sludge-bomb"), TEXT("toxic"), TEXT("gunk-shot"), TEXT("acid-spray"), TEXT("venoshock")}))
	{
		Lob(Mouth, Hit, 0.45f, Id == TEXT("sludge-bomb") || Id == TEXT("gunk-shot") ? 6 : 4, K, Core, Edge, ELigaFxShape::Orb, 2.f);
		return 0.55f;
	}
	if (OneOf(Id, {TEXT("shadow-ball"), TEXT("confuse-ray"), TEXT("energy-ball"), TEXT("aura-sphere"), TEXT("focus-blast"), TEXT("electro-ball"), TEXT("weather-ball")}))
	{
		const FLinearColor C1 = Id == TEXT("confuse-ray") ? Col(1.f, 0.95f, 0.4f) : Core;
		const float Travel = Id == TEXT("confuse-ray") ? 0.6f : 0.42f;
		{
			FLigaFxParticle& B = Add(ELigaFxShape::Orb, Mouth, Travel + 0.05f, 30.f * K, 46.f * K, C1, Edge, Glow);
			B.Vel = (Hit - Mouth) / Travel;
		}
		Stream(Mouth, Hit, Travel, Travel * 0.8f, K * 0.6f, C1, Edge, 6.f, Glow);
		return Travel;
	}
	if (OneOf(Id, {TEXT("night-shade"), TEXT("ominous-wind")}))
	{
		Ray(Mouth, Hit, K, Col(0.4f, 0.2f, 0.55f), Col(0.12f, 0.05f, 0.18f), 0.45f);
		return 0.4f;
	}
	if (OneOf(Id, {TEXT("powder-snow"), TEXT("blizzard"), TEXT("icy-wind"), TEXT("frost-breath")}))
	{
		Stream(Mouth, Hit, 0.4f, 0.5f, K, Core, Edge, 22.f, 4.f);
		for (int32 i = 0; i < 6; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Cone, Mouth, 0.42f, 14.f * K, 14.f * K, Core, Edge, 3.f);
			P.Stretch = FVector(0.35f, 0.35f, 1.4f);
			P.bAlignToVelocity = true;
			P.Delay = i * 0.06f;
			P.Vel = (Hit + Jit(30.f * K) - Mouth) / 0.4f;
		}
		return 0.5f;
	}
	if (OneOf(Id, {TEXT("poison-sting"), TEXT("pin-missile"), TEXT("twineedle"), TEXT("ice-shard"), TEXT("icicle-spear")}))
	{
		const int32 N = Id == TEXT("poison-sting") ? 2 : 4;
		for (int32 i = 0; i < N; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Cone, Mouth, 0.3f, 16.f * K, 16.f * K, Core, Edge, 2.5f);
			P.Stretch = FVector(0.3f, 0.3f, 1.6f);
			P.bAlignToVelocity = true;
			P.Delay = i * 0.06f;
			P.Vel = (Hit + Jit(15.f * K) - Mouth) / 0.28f;
		}
		return 0.32f;
	}
	if (OneOf(Id, {TEXT("fairy-wind"), TEXT("moonblast"), TEXT("dazzling-gleam")}))
	{
		Stream(Mouth, Hit, 0.4f, 0.45f, K * 0.7f, Core, Edge, 25.f, 5.f);
		return 0.5f;
	}

	// ——— by kind ———
	if (Move.Category == EMoveCategory::Physical)
	{
		return 0.25f;  // the attacker lunges; the hit itself shows the type
	}
	if (Move.Category == EMoveCategory::Status)
	{
		const FLigaMoveEffect& E = Move.Effect;
		if (E.bHasStats && E.bStatsSelf)
		{
			Aura(From, FromH, Core);
			return 0.6f;
		}
		if (E.Heal > 0.f || E.bRest)
		{
			Aura(From, FromH, Col(0.5f, 1.f, 0.6f));
			return 0.5f;
		}
		if (E.bProtect)
		{
			Shield(From, FromH);
			return 0.5f;
		}
		if (E.Status == EStatus::Sleep || E.Status == EStatus::Poison || E.Status == EStatus::Paralysis)
		{
			Powder(To, ToH, E.Status == EStatus::Sleep ? Col(0.55f, 0.85f, 1.f) : E.Status == EStatus::Poison ? Col(0.78f, 0.38f, 0.98f) : Col(1.f, 0.9f, 0.3f));
			return 0.75f;
		}
		Rings(Mouth, Hit, K, Edge, 4, 0.4f);
		return 0.6f;
	}
	switch (Move.Type)
	{
	case EPokeType::Fire:
	case EPokeType::Dragon:
		Stream(Mouth, Hit, 0.38f, 0.45f, K, Core, Edge, 14.f, Glow);
		return 0.5f;
	case EPokeType::Water:
		Stream(Mouth, Hit, 0.34f, 0.45f, K, Core, Edge, 8.f, 2.5f, ELigaFxShape::Orb);
		return 0.5f;
	case EPokeType::Electric:
		for (int32 i = 0; i < 2; ++i) Bolt(Mouth, Hit, K, Edge, 7, i * 0.1f);
		return 0.3f;
	case EPokeType::Grass:
		Leaves(Mouth, Hit, K, 7);
		return 0.5f;
	case EPokeType::Ice:
		Ray(Mouth, Hit, K, Core, Edge, 0.4f);
		return 0.4f;
	case EPokeType::Psychic:
		for (int32 i = 0; i < 3; ++i)
		{
			FLigaFxParticle& R = Add(ELigaFxShape::Ring, Hit, 0.4f, 160.f * KT, 20.f * KT, Core, Edge, 4.f);
			R.Delay = 0.1f + i * 0.1f;
		}
		return 0.5f;
	case EPokeType::Poison:
		Lob(Mouth, Hit, 0.45f, 4, K, Core, Edge, ELigaFxShape::Orb, 2.f);
		return 0.5f;
	case EPokeType::Ground:
		Erupt(To, KT, Edge);
		return 0.35f;
	case EPokeType::Rock:
		RocksFall(To, ToH, KT, Edge, 4);
		return 0.55f;
	case EPokeType::Flying:
	{
		const FVector C = Hit;
		const float R = ToH * 0.6f;
		Swirl(C, R, KT, Core, Edge, 22, 0.6f, ELigaFxShape::Disc, 3.f);
		return 0.45f;
	}
	default:
	{
		// Ghost, Dark, Fighting, Steel, Bug, Fairy, Normal: a ball of energy with a trail.
		{
			FLigaFxParticle& B = Add(ELigaFxShape::Orb, Mouth, 0.45f, 26.f * K, 40.f * K, Core, Edge, Glow);
			B.Vel = (Hit - Mouth) / 0.42f;
		}
		Stream(Mouth, Hit, 0.42f, 0.34f, K * 0.6f, Core, Edge, 8.f, Glow);
		return 0.45f;
	}
	}
}

void ALigaBattleFx::Impact(EPokeType Type, const FString& MoveId, const FVector& Base, float Height, bool bBig)
{
	const float K = SizeK(Height) * (bBig ? 1.35f : 1.f);
	const FVector At = Base + FVector(0.f, 0.f, Height * 0.42f);
	FLinearColor Core, Edge;
	float Glow = 4.f;
	Palette(Type, Core, Edge, Glow);
	Burst(At, K, Core, Edge, bBig ? 16 : 10, Glow);
	switch (Type)
	{
	case EPokeType::Fire:
		for (int32 i = 0; i < 9; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Disc, At + Jit(30.f * K), Rf(0.4f, 0.7f), 24.f * K, 60.f * K, Col(1.f, 0.8f, 0.3f), Col(0.6f, 0.08f, 0.02f), 5.f);
			P.Vel = FVector(Rf(-60.f, 60.f), Rf(-60.f, 60.f), Rf(120.f, 220.f)) * K;
			P.Accel = FVector(0.f, 0.f, 150.f);
		}
		break;
	case EPokeType::Water:
		for (int32 i = 0; i < 12; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Orb, At, Rf(0.5f, 0.8f), 9.f * K, 6.f * K, Col(0.75f, 0.92f, 1.f), Col(0.3f, 0.6f, 1.f), 1.5f);
			P.Opacity = 0.75f;
			P.Vel = FVector(Rf(-250.f, 250.f), Rf(-250.f, 250.f), Rf(300.f, 500.f)) * K;
			P.Accel = FVector(0.f, 0.f, -1100.f);
		}
		break;
	case EPokeType::Electric:
		for (int32 i = 0; i < 3; ++i) Bolt(At + Jit(50.f * K) + FVector(0.f, 0.f, 40.f * K), At + Jit(40.f * K), K * 0.6f, Edge, 4, i * 0.05f);
		break;
	case EPokeType::Grass:
	case EPokeType::Bug:
		for (int32 i = 0; i < 8; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Cube, At, 0.6f, 18.f * K, 18.f * K, Col(0.45f, 0.88f, 0.3f), Col(0.25f, 0.6f, 0.15f), 1.4f);
			P.Stretch = FVector(1.f, 0.5f, 0.06f);
			P.Vel = FMath::VRand() * Rf(200.f, 350.f) * K;
			P.Accel = FVector(0.f, 0.f, -300.f);
			P.Drag = 1.5f;
			P.Rot = FRotator(Rf(0.f, 360.f), Rf(0.f, 360.f), 0.f);
			P.Spin = FRotator(Rf(-700.f, 700.f), Rf(-700.f, 700.f), 0.f);
		}
		break;
	case EPokeType::Ice:
	case EPokeType::Steel:
		for (int32 i = 0; i < 8; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Cone, At, 0.45f, 16.f * K, 10.f * K, Core, Edge, Glow);
			P.Stretch = FVector(0.35f, 0.35f, 1.3f);
			P.bAlignToVelocity = true;
			P.Vel = FMath::VRand() * Rf(250.f, 450.f) * K;
			P.Drag = 2.f;
		}
		break;
	case EPokeType::Rock:
	case EPokeType::Ground:
		for (int32 i = 0; i < 8; ++i)
		{
			const float S = 14.f * K * Rf(0.7f, 1.3f);
			FLigaFxParticle& P = Add(ELigaFxShape::Cube, At, 0.7f, S, S, Edge, Edge * 0.6f, 0.5f);
			P.Vel = FVector(Rf(-250.f, 250.f), Rf(-250.f, 250.f), Rf(150.f, 450.f)) * K;
			P.Accel = FVector(0.f, 0.f, -1500.f);
			P.Rot = FRotator(Rf(0.f, 360.f), Rf(0.f, 360.f), 0.f);
			P.Spin = FRotator(Rf(-400.f, 400.f), Rf(-400.f, 400.f), 0.f);
		}
		break;
	case EPokeType::Poison:
		for (int32 i = 0; i < 9; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Orb, At + Jit(35.f * K), Rf(0.5f, 0.8f), 8.f * K, 22.f * K, Core, Edge, 2.f);
			P.Opacity = 0.7f;
			P.Vel = FVector(0.f, 0.f, Rf(80.f, 160.f));
		}
		break;
	case EPokeType::Psychic:
	case EPokeType::Fairy:
		for (int32 i = 0; i < 2; ++i)
		{
			FLigaFxParticle& R = Add(ELigaFxShape::Ring, At, 0.4f, 30.f * K, 220.f * K, Core, Edge, Glow);
			R.Delay = 0.08f + i * 0.08f;
		}
		break;
	case EPokeType::Ghost:
	case EPokeType::Dark:
		for (int32 i = 0; i < 2; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Disc, At + Jit(20.f * K), 0.5f, 60.f * K, 170.f * K, Col(0.25f, 0.1f, 0.35f), Col(0.05f, 0.02f, 0.08f), 0.6f);
			P.Opacity = 0.8f;
			P.Delay = i * 0.06f;
		}
		break;
	case EPokeType::Flying:
		for (int32 i = 0; i < 6; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Cube, At, 0.9f, 16.f * K, 16.f * K, Col(1.f, 1.f, 1.f), Col(0.85f, 0.9f, 1.f), 1.5f);
			P.Stretch = FVector(1.f, 0.35f, 0.04f);
			P.Vel = FVector(Rf(-200.f, 200.f), Rf(-200.f, 200.f), Rf(100.f, 250.f)) * K;
			P.Accel = FVector(0.f, 0.f, -150.f);
			P.Drag = 2.f;
			P.Spin = FRotator(Rf(-300.f, 300.f), Rf(-300.f, 300.f), Rf(-300.f, 300.f));
		}
		break;
	default:
		// Normal / Fighting / Dragon: a quick star of light.
		for (int32 i = 0; i < 4; ++i)
		{
			const FVector D = FMath::VRand();
			FLigaFxParticle& P = Add(ELigaFxShape::Beam, At - D * 70.f * K, 0.14f, 12.f * K, 4.f * K, Core, Edge, 8.f);
			P.BeamEnd = At + D * 70.f * K;
		}
		break;
	}
}

void ALigaBattleFx::StatusDamage(const FString& Source, const FVector& Base, float Height)
{
	const float K = SizeK(Height);
	const FVector At = Base + FVector(0.f, 0.f, Height * 0.42f);
	if (Source == TEXT("status:burn"))
	{
		for (int32 i = 0; i < 12; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Disc, Base + JitXY(Height * 0.4f), Rf(0.4f, 0.7f), 22.f * K, 55.f * K, Col(1.f, 0.8f, 0.3f), Col(0.6f, 0.08f, 0.02f), 5.f);
			P.Delay = i * 0.03f;
			P.Vel = FVector(0.f, 0.f, Rf(150.f, 280.f)) * K;
		}
		Flash(At, Col(1.f, 0.4f, 0.1f), 0.6f);
	}
	else if (Source == TEXT("status:poison"))
	{
		for (int32 i = 0; i < 10; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Orb, At + Jit(Height * 0.35f), Rf(0.5f, 0.8f), 8.f * K, 24.f * K, Col(0.88f, 0.55f, 1.f), Col(0.5f, 0.1f, 0.62f), 2.f);
			P.Opacity = 0.75f;
			P.Delay = i * 0.04f;
			P.Vel = FVector(0.f, 0.f, Rf(80.f, 150.f));
		}
	}
	else if (Source == TEXT("status:confusion"))
	{
		Burst(At, K * 0.8f, Col(1.f, 1.f, 0.9f), Col(1.f, 0.85f, 0.3f), 8, 5.f);
		Confused(Base, Height);
	}
	else
	{
		Burst(At, K * 0.7f, Col(0.9f, 0.9f, 0.9f), Col(0.6f, 0.6f, 0.65f), 6, 2.f);
	}
}

void ALigaBattleFx::StatusBurst(EStatus Status, const FVector& Base, float Height)
{
	const float K = SizeK(Height);
	const FVector At = Base + FVector(0.f, 0.f, Height * 0.45f);
	switch (Status)
	{
	case EStatus::Burn:
		StatusDamage(TEXT("status:burn"), Base, Height);
		break;
	case EStatus::Poison:
		StatusDamage(TEXT("status:poison"), Base, Height);
		break;
	case EStatus::Paralysis:
		for (int32 i = 0; i < 4; ++i) Bolt(At + Jit(Height * 0.4f), At + Jit(Height * 0.4f), K * 0.6f, Col(1.f, 0.85f, 0.1f), 4, i * 0.06f);
		break;
	case EStatus::Sleep:
		for (int32 i = 0; i < 3; ++i)
		{
			FLigaFxParticle& R = Add(ELigaFxShape::Ring, At, 0.7f, 30.f * K, 160.f * K, Col(0.7f, 0.85f, 1.f), Col(0.4f, 0.55f, 1.f), 2.f);
			R.Delay = i * 0.15f;
		}
		break;
	case EStatus::Freeze:
		for (int32 i = 0; i < 10; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Cone, At, 0.5f, 16.f * K, 10.f * K, Col(0.92f, 1.f, 1.f), Col(0.42f, 0.82f, 1.f), 4.f);
			P.Stretch = FVector(0.35f, 0.35f, 1.3f);
			P.bAlignToVelocity = true;
			P.Vel = FMath::VRand() * Rf(200.f, 400.f) * K;
			P.Drag = 2.f;
		}
		Flash(At, Col(0.6f, 0.85f, 1.f), 0.8f);
		break;
	default:
		// Cured: a light, clean sparkle.
		for (int32 i = 0; i < 10; ++i)
		{
			FLigaFxParticle& P = Add(ELigaFxShape::Disc, At + Jit(Height * 0.4f), 0.5f, 6.f * K, 18.f * K, Col(1.f, 1.f, 1.f), Col(0.7f, 1.f, 0.85f), 5.f);
			P.Delay = i * 0.03f;
			P.Vel = FVector(0.f, 0.f, 80.f);
		}
		break;
	}
}

void ALigaBattleFx::StatChange(const FVector& Base, float Height, bool bUp)
{
	const float K = SizeK(Height);
	const FLinearColor C = bUp ? Col(0.4f, 0.75f, 1.f) : Col(1.f, 0.35f, 0.35f);
	for (int32 i = 0; i < 8; ++i)
	{
		const float A = i / 8.f * 2.f * PI + Rf(-0.3f, 0.3f);
		const FVector P0 = Base + FVector(FMath::Cos(A) * Height * 0.45f, FMath::Sin(A) * Height * 0.45f, bUp ? Rf(0.f, Height * 0.3f) : Height * Rf(0.7f, 1.f));
		FLigaFxParticle& P = Add(ELigaFxShape::Cone, P0, 0.6f, 18.f * K, 18.f * K, C, C, 4.f);
		P.Stretch = FVector(0.6f, 0.6f, 0.9f);
		P.Rot = bUp ? FRotator::ZeroRotator : FRotator(180.f, 0.f, 0.f);
		P.Vel = FVector(0.f, 0.f, (bUp ? 1.f : -1.f) * Height * 0.9f);
		P.Delay = i * 0.03f;
	}
	Add(ELigaFxShape::FlatRing, Base + FVector(0.f, 0.f, 5.f), 0.5f, 40.f * K, 150.f * K, C, C, 3.f);
}

void ALigaBattleFx::Heal(const FVector& Base, float Height)
{
	const float K = SizeK(Height);
	for (int32 i = 0; i < 14; ++i)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, Base + JitXY(Height * 0.45f) + FVector(0.f, 0.f, Rf(0.f, Height * 0.4f)), 0.7f, 8.f * K, 20.f * K,
			Col(0.85f, 1.f, 0.9f), Col(0.35f, 1.f, 0.55f), 5.f);
		P.Delay = i * 0.03f;
		P.Vel = FVector(0.f, 0.f, Height * Rf(0.7f, 1.1f));
	}
	Add(ELigaFxShape::FlatRing, Base + FVector(0.f, 0.f, 5.f), 0.6f, 40.f * K, 170.f * K, Col(0.6f, 1.f, 0.7f), Col(0.3f, 1.f, 0.5f), 3.f);
	Flash(Base + FVector(0.f, 0.f, Height * 0.5f), Col(0.4f, 1.f, 0.6f), 0.5f);
}

void ALigaBattleFx::Confused(const FVector& Base, float Height)
{
	const float K = SizeK(Height);
	for (int32 i = 0; i < 3; ++i)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, Base, 1.4f, 14.f * K, 14.f * K, Col(1.f, 1.f, 0.6f), Col(1.f, 0.85f, 0.2f), 6.f);
		P.bOrbit = true;
		P.OrbitCenter = Base + FVector(0.f, 0.f, Height * 0.95f);
		P.OrbitRadius = Height * 0.3f;
		P.OrbitSpeed = 6.f;
		P.OrbitAngle = i * 2.f * PI / 3.f;
	}
}

void ALigaBattleFx::Shield(const FVector& Base, float Height)
{
	const float K = SizeK(Height);
	{
		FLigaFxParticle& S = Add(ELigaFxShape::Orb, Base + FVector(0.f, 0.f, Height * 0.45f), 0.8f, Height * 1.1f, Height * 1.3f, Col(0.5f, 1.f, 0.7f), Col(0.3f, 0.9f, 0.5f), 1.5f);
		S.Opacity = 0.4f;
	}
	Add(ELigaFxShape::Ring, Base + FVector(0.f, 0.f, Height * 0.45f), 0.5f, Height * 0.8f, Height * 1.5f, Col(0.6f, 1.f, 0.8f), Col(0.3f, 0.9f, 0.5f), 3.f);
	Flash(Base + FVector(0.f, 0.f, Height * 0.5f), Col(0.4f, 1.f, 0.6f), 0.4f);
	(void)K;
}

void ALigaBattleFx::BallOpen(const FVector& At, float Size)
{
	const float K = FMath::Clamp(Size / 120.f, 0.6f, 2.2f);
	Add(ELigaFxShape::Disc, At, 0.3f, 20.f * K, 220.f * K, Col(1.f, 1.f, 1.f), Col(1.f, 0.6f, 0.6f), 6.f);
	Add(ELigaFxShape::Ring, At, 0.4f, 20.f * K, 240.f * K, Col(1.f, 0.4f, 0.35f), Col(1.f, 0.9f, 0.9f), 4.f);
	for (int32 i = 0; i < 10; ++i)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, At, 0.45f, 12.f * K, 3.f * K, Col(1.f, 1.f, 1.f), Col(1.f, 0.7f, 0.7f), 5.f);
		P.Vel = FMath::VRand() * Rf(250.f, 450.f) * K;
		P.Drag = 3.f;
	}
	Flash(At, Col(1.f, 0.9f, 0.9f), 1.f);
}

void ALigaBattleFx::CaptureSparkles(const FVector& At)
{
	for (int32 i = 0; i < 8; ++i)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, At + Jit(30.f), 0.6f, 4.f, 26.f, Col(1.f, 1.f, 0.7f), Col(1.f, 0.85f, 0.3f), 7.f);
		P.Delay = i * 0.05f;
		P.Vel = FVector(Rf(-60.f, 60.f), Rf(-60.f, 60.f), Rf(80.f, 160.f));
	}
	Flash(At, Col(1.f, 0.95f, 0.7f), 0.7f);
}

void ALigaBattleFx::Faint(const FVector& Base, float Height)
{
	const float K = SizeK(Height);
	for (int32 i = 0; i < 9; ++i)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, Base + JitXY(Height * 0.3f) + FVector(0.f, 0.f, 15.f * K), 0.9f, 30.f * K, 90.f * K, Col(0.75f, 0.72f, 0.68f), Col(0.5f, 0.48f, 0.45f), 0.6f);
		P.Opacity = 0.6f;
		P.Vel = FVector(Rf(-90.f, 90.f), Rf(-90.f, 90.f), Rf(10.f, 50.f)) * K;
		P.Drag = 1.5f;
	}
	Add(ELigaFxShape::FlatRing, Base + FVector(0.f, 0.f, 5.f), 0.6f, 40.f * K, 200.f * K, Col(0.8f, 0.78f, 0.74f), Col(0.6f, 0.58f, 0.55f), 1.f);
}

void ALigaBattleFx::Miss(const FVector& Base, float Height)
{
	const float K = SizeK(Height);
	for (int32 i = 0; i < 4; ++i)
	{
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, Base + FVector(0.f, 0.f, Height * 0.5f) + Jit(Height * 0.6f), 0.35f, 20.f * K, 50.f * K, Col(1.f, 1.f, 1.f), Col(0.8f, 0.85f, 0.9f), 1.5f);
		P.Opacity = 0.5f;
		P.Delay = i * 0.04f;
	}
}

// ——— status auras ———

void ALigaBattleFx::SetAura(int32 Side, EStatus Status, const FVector& Base, float Height)
{
	if (Side < 0 || Side > 1) return;
	FLigaFxAura& A = Auras[Side];
	if (A.Status == Status && A.Base.Equals(Base, 1.f)) return;
	for (FLigaFxParticle& P : Live)
	{
		if (P.AuraSide == Side) P.Life = FMath::Min(P.Life, P.Age + 0.15f);
	}
	A.Status = Status;
	A.Base = Base;
	A.Height = Height;
	A.Timer = 0.f;
	if (Status == EStatus::Freeze)
	{
		// A block of ice around the Pokémon for as long as it is frozen.
		FLigaFxParticle& P = Add(ELigaFxShape::Cube, Base + FVector(0.f, 0.f, Height * 0.42f), 1.0e6f, Height * 0.95f, Height * 0.95f, Col(0.75f, 0.92f, 1.f), Col(0.75f, 0.92f, 1.f), 1.2f);
		P.Stretch = FVector(0.85f, 0.85f, 0.95f);
		P.Opacity = 0.35f;
		P.Rot = FRotator(0.f, Rf(0.f, 90.f), 0.f);
		P.AuraSide = Side;
	}
}

void ALigaBattleFx::TickAura(int32 Side, float Dt)
{
	FLigaFxAura& A = Auras[Side];
	if (A.Status == EStatus::None) return;
	A.Timer -= Dt;
	if (A.Timer > 0.f) return;
	const float H = A.Height;
	const float K = SizeK(H);
	const FVector Base = A.Base;
	switch (A.Status)
	{
	case EStatus::Burn:
	{
		A.Timer = 0.14f;
		const float Ang = Rf(0.f, 2.f * PI);
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, Base + FVector(FMath::Cos(Ang) * H * 0.35f, FMath::Sin(Ang) * H * 0.35f, Rf(0.f, H * 0.4f)), 0.5f, 16.f * K, 34.f * K,
			Col(1.f, 0.8f, 0.3f), Col(0.75f, 0.12f, 0.03f), 5.f);
		P.Vel = FVector(0.f, 0.f, Rf(120.f, 200.f) * K);
		P.AuraSide = Side;
		break;
	}
	case EStatus::Poison:
	{
		A.Timer = 0.28f;
		FLigaFxParticle& P = Add(ELigaFxShape::Orb, Base + JitXY(H * 0.35f) + FVector(0.f, 0.f, Rf(H * 0.2f, H * 0.7f)), 0.7f, 6.f * K, 16.f * K,
			Col(0.88f, 0.55f, 1.f), Col(0.5f, 0.1f, 0.62f), 2.f);
		P.Opacity = 0.7f;
		P.Vel = FVector(0.f, 0.f, 60.f * K);
		P.AuraSide = Side;
		break;
	}
	case EStatus::Paralysis:
	{
		A.Timer = 0.5f;
		const FVector C = Base + FVector(0.f, 0.f, H * 0.45f);
		Bolt(C + Jit(H * 0.45f), C + Jit(H * 0.45f), K * 0.45f, Col(1.f, 0.85f, 0.1f), 3);
		break;
	}
	case EStatus::Sleep:
	{
		A.Timer = 1.2f;
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, Base + FVector(0.f, 0.f, H * 0.9f), 1.2f, 10.f * K, 30.f * K, Col(0.75f, 0.85f, 1.f), Col(0.5f, 0.6f, 1.f), 2.f);
		P.Vel = FVector(Rf(-20.f, 20.f), Rf(-20.f, 20.f), 50.f);
		P.Opacity = 0.6f;
		P.AuraSide = Side;
		break;
	}
	case EStatus::Freeze:
	{
		A.Timer = 0.6f;
		FLigaFxParticle& P = Add(ELigaFxShape::Disc, Base + FVector(0.f, 0.f, H * 0.45f) + Jit(H * 0.5f), 0.5f, 4.f * K, 18.f * K, Col(1.f, 1.f, 1.f), Col(0.6f, 0.9f, 1.f), 7.f);
		P.AuraSide = Side;
		break;
	}
	default:
		A.Timer = 1.f;
		break;
	}
}
