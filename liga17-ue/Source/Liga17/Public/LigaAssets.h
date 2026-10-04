// Лига 17 — asset paths written by Content/Python/liga_setup.py into Content/Liga/Data/assets.json,
// plus the layout exported from Blender (Content/Liga/Data/layout.json).
#pragma once

#include "CoreMinimal.h"

class UStaticMesh;
class UMaterialInterface;
class USkeletalMesh;
class UObject;
class FJsonObject;

/** A 3D Pokémon model imported by Content/Python/liga_pokemon3d.py (skeletal or static mesh + optional animations). */
struct FLigaModel3D
{
	FString Mesh;
	FString Idle;
	FString Attack;
	FString Faint;
};

struct LIGA17_API FLigaAssets
{
	static const FLigaAssets& Get();

	FString CharacterMesh;
	FString CharacterAnimClass;
	FString BillboardMaterial;
	FString PlayerVrm;                 // VrmAssetListObject of the player's VRoid character
	FString PlayerRtg;                 // IK retargeter mannequin -> that character (made by VRM4U on import)
	TMap<FString, FString> NpcVrm;     // NPC id (or look) -> VrmAssetListObject
	TMap<FString, FString> NpcRtg;     // NPC id (or look) -> IK retargeter
	TMap<FString, FString> Kit;        // kit asset name -> static mesh path
	TMap<FString, FLigaModel3D> Pokemon3D;  // "25" (regular) or "25s" (shiny) -> model

	/** The model for a species, or null (the battle then shows the HOME picture). Shiny ones need their own model. */
	const FLigaModel3D* FindModel3D(int32 Species, bool bShiny) const;

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
