// Лига 17 — builds the living parts of the level at runtime from layout.json: sky and lighting, instanced
// foliage (grass, trees, flowers), NPCs, door interaction points and tall-grass encounter zones.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "LigaWorldBuilder.generated.h"

class UHierarchicalInstancedStaticMeshComponent;

UCLASS()
class LIGA17_API ALigaWorldBuilder : public AActor
{
	GENERATED_BODY()

public:
	ALigaWorldBuilder();

	virtual void BeginPlay() override;

	/** Blender layout coordinates (metres, X east, Y north, Z up) -> Unreal world (cm). */
	FVector ToWorld(const FVector& Blender) const;
	float ToWorldYaw(float BlenderYawRadians) const;
	/** Inverse of ToWorld in the horizontal plane (Z is approximate). */
	FVector ToBlender(const FVector& World) const;
	/** Drops a point onto the ground (terrain / buildings). */
	FVector Ground(const FVector& World, float Up = 2000.f) const;

	FVector PlayerStartWorld() const;
	float PlayerStartYaw() const;

private:
	UPROPERTY() TArray<TObjectPtr<UHierarchicalInstancedStaticMeshComponent>> Foliage;

	FVector Origin = FVector::ZeroVector;
	FVector AxisX = FVector(100.f, 0.f, 0.f);  // per Blender metre
	FVector AxisY = FVector(0.f, -100.f, 0.f);
	FVector AxisZ = FVector(0.f, 0.f, 100.f);

	void FindAxes();
	void EnsureLighting();
	void SpawnFoliage();
	void SpawnNpcs();
	void SpawnDoors();
	void SpawnZones();
	void PlacePlayer();
};
