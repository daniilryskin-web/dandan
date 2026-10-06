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
	FString Walk;
	/** Shown frozen at its first frame when there is no idle clip (Pikachu's rest pose lies on its belly). */
	FString Pose;
};

struct LIGA17_API FLigaAssets
{
	static const FLigaAssets& Get();

	FString CharacterMesh;
	FString CharacterAnimClass;
	FString BillboardMaterial;
	/** Translucent material for battle effects (made by the setup script); empty when the setup has not been re-run. */
	FString FxMaterial;
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
	/** Waypoints (Blender x, y) the NPC walks along; empty = stands still. */
	TArray<FVector2D> Route;
	bool bLoop = true;
	float Speed = 1.2f;   // m/s
	float Pause = 2.f;    // s at each waypoint
};

struct FLigaZoneDef
{
	float X0 = 0, X1 = 0, Y0 = 0, Y1 = 0;
	FString Route;
	FString Kind;
	/** Shown in battle ("Маршрут 1", "Берег Паллет-тауна"). */
	FString Place;
	/** Extra margin around the rectangle, metres. */
	float Pad = 3.5f;
};

/** A door: into a building (enter), back outside (exit), or a service spot such as the Poké Center PC (pc). */
struct FLigaPortalDef
{
	FString Id;
	FString Kind;
	FString Title;
	FVector Pos = FVector::ZeroVector;   // Blender metres
	FVector To = FVector::ZeroVector;    // where the player appears
	float ToFace = 0.f;
};

/** A named area: a room (indoor, with ceiling lights) or a part of the outdoors. */
struct FLigaPlaceDef
{
	FString Id;
	FString Name;
	bool bIndoor = false;
	float X0 = 0, X1 = 0, Y0 = 0, Y1 = 0;
	float Z0 = -1.0e6f, Z1 = 1.0e6f;
	/** x, y, z (Blender metres) and intensity (candela). */
	TArray<FVector4> Lights;

	bool Contains(const FVector& B) const { return B.X >= X0 && B.X <= X1 && B.Y >= Y0 && B.Y <= Y1 && B.Z >= Z0 && B.Z <= Z1; }
};

/** A Pokémon living in town; Quest set = shown only while that quest needs it. */
struct FLigaAmbientDef
{
	int32 Species = 0;
	FVector Pos = FVector::ZeroVector;
	float Radius = 3.f;
	FString Quest;
};

struct LIGA17_API FLigaLayout
{
	static const FLigaLayout& Get();

	bool bLoaded = false;
	FVector PlayerStart = FVector::ZeroVector;
	float PlayerFace = 0.f;
	TMap<FString, FVector2D> Doors;
	TArray<FLigaPortalDef> Portals;
	TArray<FLigaPlaceDef> Places;
	TArray<FLigaNpcDef> Npcs;
	TArray<FLigaAmbientDef> Ambient;
	TArray<FLigaZoneDef> Zones;
	TMap<FString, TArray<FLigaInstance>> Instances;
	float SeaLevel = -0.9f;

	/** The most specific named place containing a Blender-space point (rooms first), or null. */
	const FLigaPlaceDef* PlaceAt(const FVector& Blender) const;
	const FLigaPlaceDef* FindPlace(const FString& Id) const;
	/** Rooms are far below the map: layout points under this height are indoors. */
	static bool IsIndoorPoint(const FVector& Blender) { return Blender.Z < -10.f; }

private:
	void Load();
};
