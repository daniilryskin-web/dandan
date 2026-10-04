// Лига 17 — asset paths written by Content/Python/liga_setup.py into Content/Liga/Data/assets.json,
// plus the layout exported from Blender (Content/Liga/Data/layout.json).
#pragma once

#include "CoreMinimal.h"

class UStaticMesh;
class UMaterialInterface;
class USkeletalMesh;
class UObject;
class FJsonObject;

struct LIGA17_API FLigaAssets
{
	static const FLigaAssets& Get();

	FString CharacterMesh;
	FString CharacterAnimClass;
	FString BillboardMaterial;
	FString PlayerVrm;                 // VrmAssetListObject of the player's VRoid character
	TMap<FString, FString> NpcVrm;     // NPC look id -> VrmAssetListObject
	TMap<FString, FString> Kit;        // kit asset name -> static mesh path

	UStaticMesh* KitMesh(const FString& Name) const;
	UMaterialInterface* LoadBillboardMaterial() const;
	USkeletalMesh* LoadCharacterMesh() const;
	UClass* LoadCharacterAnimClass() const;

private:
	void Load();
};

/** One scattered foliage/prop instance in Blender coordinates (metres). */
struct FLigaInstance
{
	FVector Pos;
	float Yaw = 0.f;
	float Scale = 1.f;
};

struct FLigaNpcDef
{
	FString Id;
	FString Name;
	FString Look;
	FVector Pos;
	float Face = 0.f;
	TArray<FString> Lines;
};

struct FLigaZoneDef
{
	float X0 = 0, X1 = 0, Y0 = 0, Y1 = 0;
	FString Route;
};

struct LIGA17_API FLigaLayout
{
	static const FLigaLayout& Get();

	bool bLoaded = false;
	FVector PlayerStart = FVector::ZeroVector;
	float PlayerFace = 0.f;
	TMap<FString, FVector2D> Doors;
	TArray<FLigaNpcDef> Npcs;
	TArray<FLigaZoneDef> Zones;
	TMap<FString, TArray<FLigaInstance>> Instances;
	float SeaLevel = -0.9f;

private:
	void Load();
};
