// Лига 17 — battle effects without any effect assets: glowing puffs, rings, sparks, bolts, leaves, bubbles and rocks
// made from the engine's basic shapes with one translucent material (M_LigaFx, created by the setup script).
// Every move gets an effect from its type and kind (fire spits flames, water sprays, electricity strikes),
// well-known moves get their own, and status conditions show around the Pokémon while they last.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "LigaTypes.h"
#include "LigaBattleFx.generated.h"

class UMaterialInstanceDynamic;
class UMaterialInterface;
class UPointLightComponent;
class UStaticMesh;
class UStaticMeshComponent;
struct FLigaMove;

enum class ELigaFxShape : uint8
{
	Disc,      // soft glowing puff facing the camera
	Ring,      // ring facing the camera
	FlatRing,  // ring lying on the ground
	Orb,       // sphere with soft edges (bubble, ball of energy)
	Cube,      // rock, leaf, shard (use Stretch)
	Cone,      // arrow, spike
	Beam,      // box stretched from Pos to BeamEnd (lightning, rays, vines)
};

struct FLigaFxParticle
{
	ELigaFxShape Shape = ELigaFxShape::Disc;
	int32 Slot = INDEX_NONE;
	float Delay = 0.f;
	float Age = 0.f;
	float Life = 0.6f;
	FVector Pos = FVector::ZeroVector;
	FVector Vel = FVector::ZeroVector;
	FVector Accel = FVector::ZeroVector;
	float Drag = 0.f;
	float Size0 = 20.f;
	float Size1 = 20.f;
	FVector Stretch = FVector::OneVector;
	FLinearColor Color0 = FLinearColor::White;
	FLinearColor Color1 = FLinearColor::White;
	float Glow = 3.f;
	float Opacity = 1.f;
	FRotator Rot = FRotator::ZeroRotator;
	FRotator Spin = FRotator::ZeroRotator;
	bool bAlignToVelocity = false;
	FVector BeamEnd = FVector::ZeroVector;
	bool bOrbit = false;
	FVector OrbitCenter = FVector::ZeroVector;
	float OrbitRadius = 0.f;
	float OrbitSpeed = 0.f;
	float OrbitAngle = 0.f;
	float OrbitRise = 0.f;
	/** Part of a status aura of this side (removed when the status ends). */
	int32 AuraSide = -1;
};

/** A status condition shown around one of the two Pokémon. */
struct FLigaFxAura
{
	EStatus Status = EStatus::None;
	FVector Base = FVector::ZeroVector;
	float Height = 100.f;
	float Timer = 0.f;
};

/** Spawns particles over time: Spawn(progress 0..1) every Interval seconds for Duration seconds. */
struct FLigaFxEmitter
{
	float Delay = 0.f;
	float Duration = 0.f;
	float Interval = 0.05f;
	float Clock = 0.f;
	float Next = 0.f;
	TFunction<void(float)> Spawn;
};

UCLASS()
class LIGA17_API ALigaBattleFx : public AActor
{
	GENERATED_BODY()

public:
	ALigaBattleFx();

	virtual void Tick(float DeltaSeconds) override;

	/** Where the battle camera is (billboards face it). */
	FVector ViewPos = FVector::ZeroVector;

	/** The first part of a move (flames flying, a bolt, powder...). From/To are the Pokémon's feet, heights in cm.
	 *  Returns the seconds until it reaches the target, when the battle shows the hit. */
	float PlayMove(const FLigaMove& Move, const FVector& From, float FromHeight, const FVector& To, float ToHeight);
	/** The hit of a move of this type on a Pokémon (bigger for critical / super effective hits). */
	void Impact(EPokeType Type, const FString& MoveId, const FVector& Base, float Height, bool bBig);
	/** Damage that is not from a move: "status:burn", "status:poison", "status:confusion", "recoil". */
	void StatusDamage(const FString& Source, const FVector& Base, float Height);
	void StatusBurst(EStatus Status, const FVector& Base, float Height);
	void StatChange(const FVector& Base, float Height, bool bUp);
	void Heal(const FVector& Base, float Height);
	void Confused(const FVector& Base, float Height);
	void Shield(const FVector& Base, float Height);
	void BallOpen(const FVector& At, float Size);
	void CaptureSparkles(const FVector& At);
	void Faint(const FVector& Base, float Height);
	void Miss(const FVector& Base, float Height);
	/** Keeps showing a status condition around a Pokémon (None turns it off). */
	void SetAura(int32 Side, EStatus Status, const FVector& Base, float Height);

private:
	UPROPERTY() TObjectPtr<USceneComponent> Root;
	UPROPERTY() TArray<TObjectPtr<UStaticMeshComponent>> Pool;
	UPROPERTY() TArray<TObjectPtr<UMaterialInstanceDynamic>> Mids;
	UPROPERTY() TObjectPtr<UPointLightComponent> Light;
	UPROPERTY() TObjectPtr<UStaticMesh> PlaneMesh;
	UPROPERTY() TObjectPtr<UStaticMesh> SphereMesh;
	UPROPERTY() TObjectPtr<UStaticMesh> CubeMesh;
	UPROPERTY() TObjectPtr<UStaticMesh> ConeMesh;
	UPROPERTY() TObjectPtr<UStaticMesh> CylinderMesh;
	UPROPERTY() TObjectPtr<UMaterialInterface> Material;

	/** M_LigaFx found: translucent soft shapes. Otherwise the engine's opaque basic material (shapes shrink to fade). */
	bool bSoft = false;
	TArray<FLigaFxParticle> Live;
	TArray<FLigaFxEmitter> Emitters;
	TArray<int32> FreeSlots;
	float LightLevel = 0.f;

	FLigaFxAura Auras[2];

	FLigaFxParticle& Add(ELigaFxShape Shape, const FVector& Pos, float Life, float Size0, float Size1, const FLinearColor& C0, const FLinearColor& C1, float Glow = 3.f);
	void Emit(float Delay, float Duration, float Interval, TFunction<void(float)> Spawn);
	void Later(float Delay, TFunction<void()> Do);
	void Flash(const FVector& At, const FLinearColor& Color, float Strength);
	int32 AcquireSlot();
	void ReleaseSlot(int32 Slot);
	UStaticMesh* MeshFor(ELigaFxShape Shape) const;
	bool UpdateParticle(FLigaFxParticle& P, float Dt);
	void TickAura(int32 Side, float Dt);

	// building blocks
	void Burst(const FVector& At, float K, const FLinearColor& Core, const FLinearColor& Edge, int32 Sparks, float Glow = 4.f);
	void Stream(const FVector& From, const FVector& To, float Travel, float Duration, float K, const FLinearColor& Core, const FLinearColor& Edge, float Spread, float Glow, ELigaFxShape Shape = ELigaFxShape::Disc);
	void Bolt(const FVector& From, const FVector& To, float K, const FLinearColor& Color, int32 Segments, float Delay = 0.f);
	void Lob(const FVector& From, const FVector& To, float Travel, int32 Count, float K, const FLinearColor& Core, const FLinearColor& Edge, ELigaFxShape Shape, float Glow);
	void Swirl(const FVector& Center, float Radius, float K, const FLinearColor& Core, const FLinearColor& Edge, int32 Count, float Duration, ELigaFxShape Shape, float Glow);
	void Rings(const FVector& From, const FVector& To, float K, const FLinearColor& Color, int32 Count, float Duration);
	void Powder(const FVector& Base, float Height, const FLinearColor& Color);
	void Leaves(const FVector& From, const FVector& To, float K, int32 Count);
	void RocksFall(const FVector& Base, float Height, float K, const FLinearColor& Color, int32 Count);
	void Erupt(const FVector& Base, float K, const FLinearColor& Color);
	void Ray(const FVector& From, const FVector& To, float K, const FLinearColor& Core, const FLinearColor& Edge, float Duration);
	void Aura(const FVector& Base, float Height, const FLinearColor& Color);
};
