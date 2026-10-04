#include "LigaAssets.h"

#include "Animation/AnimInstance.h"
#include "Dom/JsonObject.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "LigaData.h"
#include "LigaJson.h"
#include "Materials/MaterialInterface.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

DEFINE_LOG_CATEGORY_STATIC(LogLigaAssets, Log, All);

namespace
{
	TSharedPtr<FJsonObject> ReadJsonObject(const FString& File)
	{
		FString Text;
		if (!FFileHelper::LoadFileToString(Text, *(FLigaDatabase::DataDir() / File))) return nullptr;
		TSharedPtr<FJsonObject> Root;
		TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
		if (!FJsonSerializer::Deserialize(Reader, Root)) return nullptr;
		return Root;
	}

	// Paths used by the Third Person content pack in recent engine versions; the setup script records the real ones.
	const TCHAR* GMeshCandidates[] = {
		TEXT("/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple.SKM_Manny_Simple"),
		TEXT("/Game/Characters/Mannequins/Meshes/SKM_Manny.SKM_Manny"),
		TEXT("/Game/Characters/Mannequins/Meshes/SKM_Quinn_Simple.SKM_Quinn_Simple"),
	};
	const TCHAR* GAnimCandidates[] = {
		TEXT("/Game/Characters/Mannequins/Anims/Unarmed/ABP_Unarmed.ABP_Unarmed_C"),
		TEXT("/Game/Characters/Mannequins/Animations/ABP_Manny.ABP_Manny_C"),
		TEXT("/Game/Characters/Mannequins/Anims/ABP_Manny.ABP_Manny_C"),
		TEXT("/Game/Characters/Mannequins/Animations/ABP_Quinn.ABP_Quinn_C"),
	};

	FVector Vec3(const TSharedPtr<FJsonObject>& O)
	{
		double X = 0, Y = 0, Z = 0;
		O->TryGetNumberField(TEXT("x"), X);
		O->TryGetNumberField(TEXT("y"), Y);
		O->TryGetNumberField(TEXT("z"), Z);
		return FVector(X, Y, Z);
	}
}

const FLigaAssets& FLigaAssets::Get()
{
	static FLigaAssets Instance;
	static bool bLoaded = false;
	if (!bLoaded)
	{
		bLoaded = true;
		Instance.Load();
	}
	return Instance;
}

void FLigaAssets::Load()
{
	BillboardMaterial = TEXT("/Game/Liga/Materials/M_Billboard.M_Billboard");
	const TSharedPtr<FJsonObject> Root = ReadJsonObject(TEXT("assets.json"));
	if (!Root)
	{
		UE_LOG(LogLigaAssets, Warning, TEXT("assets.json not found — run Content/Python/liga_setup.py in the editor"));
		return;
	}
	Root->TryGetStringField(TEXT("character_mesh"), CharacterMesh);
	Root->TryGetStringField(TEXT("character_anim"), CharacterAnimClass);
	Root->TryGetStringField(TEXT("billboard_material"), BillboardMaterial);
	Root->TryGetStringField(TEXT("player_vrm"), PlayerVrm);
	Root->TryGetStringField(TEXT("player_rtg"), PlayerRtg);
	const TSharedPtr<FJsonObject>* Obj;
	if (Root->TryGetObjectField(TEXT("npc_vrm"), Obj))
	{
		for (const auto& KV : (*Obj)->Values) NpcVrm.Add(LigaJsonKey(KV.Key), KV.Value->AsString());
	}
	if (Root->TryGetObjectField(TEXT("npc_rtg"), Obj))
	{
		for (const auto& KV : (*Obj)->Values) NpcRtg.Add(LigaJsonKey(KV.Key), KV.Value->AsString());
	}
	if (Root->TryGetObjectField(TEXT("kit"), Obj))
	{
		for (const auto& KV : (*Obj)->Values) Kit.Add(LigaJsonKey(KV.Key), KV.Value->AsString());
	}
}

UStaticMesh* FLigaAssets::KitMesh(const FString& Name) const
{
	const FString* Path = Kit.Find(Name);
	const FString P = Path ? *Path : FString::Printf(TEXT("/Game/Liga/Kit/%s.%s"), *Name, *Name);
	return LoadObject<UStaticMesh>(nullptr, *P, nullptr, LOAD_NoWarn | LOAD_Quiet);
}

UMaterialInterface* FLigaAssets::LoadBillboardMaterial() const
{
	if (UMaterialInterface* M = LoadObject<UMaterialInterface>(nullptr, *BillboardMaterial, nullptr, LOAD_NoWarn | LOAD_Quiet)) return M;
	// Engine fallback: unlit masked material with a "SlateUI" texture parameter.
	return LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/EngineMaterials/Widget3DPassThrough_Masked_OneSided.Widget3DPassThrough_Masked_OneSided"));
}

USkeletalMesh* FLigaAssets::LoadCharacterMesh() const
{
	if (!CharacterMesh.IsEmpty())
	{
		if (USkeletalMesh* M = LoadObject<USkeletalMesh>(nullptr, *CharacterMesh, nullptr, LOAD_NoWarn | LOAD_Quiet)) return M;
	}
	for (const TCHAR* P : GMeshCandidates)
	{
		if (USkeletalMesh* M = LoadObject<USkeletalMesh>(nullptr, P, nullptr, LOAD_NoWarn | LOAD_Quiet)) return M;
	}
	return nullptr;
}

UClass* FLigaAssets::LoadCharacterAnimClass() const
{
	if (!CharacterAnimClass.IsEmpty())
	{
		if (UClass* C = LoadClass<UAnimInstance>(nullptr, *CharacterAnimClass, nullptr, LOAD_NoWarn | LOAD_Quiet)) return C;
	}
	for (const TCHAR* P : GAnimCandidates)
	{
		if (UClass* C = LoadClass<UAnimInstance>(nullptr, P, nullptr, LOAD_NoWarn | LOAD_Quiet)) return C;
	}
	return nullptr;
}

const FLigaLayout& FLigaLayout::Get()
{
	static FLigaLayout Instance;
	if (!Instance.bLoaded) Instance.Load();
	return Instance;
}

void FLigaLayout::Load()
{
	const TSharedPtr<FJsonObject> Root = ReadJsonObject(TEXT("layout.json"));
	if (!Root)
	{
		UE_LOG(LogLigaAssets, Error, TEXT("layout.json not found in Content/Liga/Data"));
		return;
	}
	bLoaded = true;
	double Sea = -0.9;
	if (Root->TryGetNumberField(TEXT("sea_level"), Sea)) SeaLevel = (float)Sea;
	const TSharedPtr<FJsonObject>* Markers;
	if (Root->TryGetObjectField(TEXT("markers"), Markers))
	{
		const TSharedPtr<FJsonObject>* Start;
		if ((*Markers)->TryGetObjectField(TEXT("player_start"), Start))
		{
			PlayerStart = Vec3(*Start);
			double F = 0;
			(*Start)->TryGetNumberField(TEXT("face"), F);
			PlayerFace = (float)F;
		}
		const TSharedPtr<FJsonObject>* DoorsObj;
		if ((*Markers)->TryGetObjectField(TEXT("doors"), DoorsObj))
		{
			for (const auto& KV : (*DoorsObj)->Values)
			{
				const FVector P = Vec3(KV.Value->AsObject());
				Doors.Add(LigaJsonKey(KV.Key), FVector2D(P.X, P.Y));
			}
		}
		const TArray<TSharedPtr<FJsonValue>>* NpcArr;
		if ((*Markers)->TryGetArrayField(TEXT("npcs"), NpcArr))
		{
			for (const TSharedPtr<FJsonValue>& V : *NpcArr)
			{
				const TSharedPtr<FJsonObject> O = V->AsObject();
				FLigaNpcDef N;
				O->TryGetStringField(TEXT("id"), N.Id);
				O->TryGetStringField(TEXT("name"), N.Name);
				O->TryGetStringField(TEXT("look"), N.Look);
				N.Pos = Vec3(O);
				double F = 0;
				O->TryGetNumberField(TEXT("face"), F);
				N.Face = (float)F;
				const TArray<TSharedPtr<FJsonValue>>* Lines;
				if (O->TryGetArrayField(TEXT("lines"), Lines))
				{
					for (const TSharedPtr<FJsonValue>& L : *Lines) N.Lines.Add(L->AsString());
				}
				Npcs.Add(N);
			}
		}
	}
	const TArray<TSharedPtr<FJsonValue>>* ZonesArr;
	if (Root->TryGetArrayField(TEXT("encounter_zones"), ZonesArr))
	{
		for (const TSharedPtr<FJsonValue>& V : *ZonesArr)
		{
			const TSharedPtr<FJsonObject> O = V->AsObject();
			FLigaZoneDef Z;
			double D = 0;
			if (O->TryGetNumberField(TEXT("x0"), D)) Z.X0 = (float)D;
			if (O->TryGetNumberField(TEXT("x1"), D)) Z.X1 = (float)D;
			if (O->TryGetNumberField(TEXT("y0"), D)) Z.Y0 = (float)D;
			if (O->TryGetNumberField(TEXT("y1"), D)) Z.Y1 = (float)D;
			O->TryGetStringField(TEXT("route"), Z.Route);
			Zones.Add(Z);
		}
	}
	const TSharedPtr<FJsonObject>* Inst;
	if (Root->TryGetObjectField(TEXT("instances"), Inst))
	{
		for (const auto& KV : (*Inst)->Values)
		{
			TArray<FLigaInstance>& List = Instances.Add(LigaJsonKey(KV.Key));
			for (const TSharedPtr<FJsonValue>& Item : KV.Value->AsArray())
			{
				const TArray<TSharedPtr<FJsonValue>>& A = Item->AsArray();
				if (A.Num() < 5) continue;
				FLigaInstance I;
				I.Pos = FVector(A[0]->AsNumber(), A[1]->AsNumber(), A[2]->AsNumber());
				I.Yaw = (float)A[3]->AsNumber();
				I.Scale = (float)A[4]->AsNumber();
				List.Add(I);
			}
		}
	}
	UE_LOG(LogLigaAssets, Log, TEXT("Layout: %d NPCs, %d zones, %d instance kinds"), Npcs.Num(), Zones.Num(), Instances.Num());
}
