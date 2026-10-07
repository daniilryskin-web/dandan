#include "LigaAssets.h"

#include "Animation/AnimInstance.h"
#include "Dom/JsonObject.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "HAL/FileManager.h"
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

	FVector Vec3(const TSharedPtr<FJsonObject>& O, const TCHAR* Px = TEXT(""))
	{
		double X = 0, Y = 0, Z = 0;
		if (!O) return FVector::ZeroVector;
		O->TryGetNumberField(FString(Px) + TEXT("x"), X);
		O->TryGetNumberField(FString(Px) + TEXT("y"), Y);
		O->TryGetNumberField(FString(Px) + TEXT("z"), Z);
		return FVector(X, Y, Z);
	}

	float Num(const TSharedPtr<FJsonObject>& O, const TCHAR* Field, float Default)
	{
		double V = Default;
		return O && O->TryGetNumberField(Field, V) ? (float)V : Default;
	}

	FString Str(const TSharedPtr<FJsonObject>& O, const TCHAR* Field)
	{
		FString V;
		if (O) O->TryGetStringField(Field, V);
		return V;
	}
}

const FLigaAssets& FLigaAssets::Get()
{
	// Reloaded whenever assets.json changes: the setup script rewrites it while the editor (and this static) stays alive.
	static FLigaAssets Instance;
	static bool bLoaded = false;
	static FDateTime Stamp;
	const FDateTime Now = IFileManager::Get().GetTimeStamp(*(FLigaDatabase::DataDir() / TEXT("assets.json")));
	if (!bLoaded || Now != Stamp)
	{
		bLoaded = true;
		Stamp = Now;
		Instance = FLigaAssets();
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
	Root->TryGetStringField(TEXT("fx_material"), FxMaterial);
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
	if (Root->TryGetObjectField(TEXT("pokemon3d"), Obj))
	{
		for (const auto& KV : (*Obj)->Values)
		{
			const TSharedPtr<FJsonObject> M = KV.Value->AsObject();
			if (!M) continue;
			FLigaModel3D D;
			M->TryGetStringField(TEXT("mesh"), D.Mesh);
			M->TryGetStringField(TEXT("idle"), D.Idle);
			M->TryGetStringField(TEXT("attack"), D.Attack);
			M->TryGetStringField(TEXT("faint"), D.Faint);
			M->TryGetStringField(TEXT("walk"), D.Walk);
			M->TryGetStringField(TEXT("pose"), D.Pose);
			if (!D.Mesh.IsEmpty()) Pokemon3D.Add(LigaJsonKey(KV.Key), D);
		}
	}
}

const FLigaModel3D* FLigaAssets::FindModel3D(int32 Species, bool bShiny) const
{
	return Pokemon3D.Find(bShiny ? FString::Printf(TEXT("%ds"), Species) : FString::Printf(TEXT("%d"), Species));
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
	// Like assets.json: re-read when the setup script copies a new layout.json while the editor stays open.
	static FLigaLayout Instance;
	static FDateTime Stamp;
	const FDateTime Now = IFileManager::Get().GetTimeStamp(*(FLigaDatabase::DataDir() / TEXT("layout.json")));
	if (!Instance.bLoaded || Now != Stamp)
	{
		Stamp = Now;
		Instance = FLigaLayout();
		Instance.Load();
	}
	return Instance;
}

const FLigaPlaceDef* FLigaLayout::PlaceAt(const FVector& B) const
{
	for (const FLigaPlaceDef& P : Places)
	{
		if (P.Contains(B)) return &P;
	}
	return nullptr;
}

const FLigaPlaceDef* FLigaLayout::FindPlace(const FString& Id) const
{
	return Places.FindByPredicate([&Id](const FLigaPlaceDef& P) { return P.Id == Id; });
}

float FLigaLayout::WaterLevelAt(const FVector& B) const
{
	for (const FLigaWaterDef& W : Waters)
	{
		if (W.Contains(B)) return W.Z;
	}
	return SeaLevel;
}

const FLigaNpcDef* FLigaLayout::FindNpc(const FString& Id) const
{
	return Npcs.FindByPredicate([&Id](const FLigaNpcDef& N) { return N.Id == Id; });
}

static TArray<FString> StrArray(const TSharedPtr<FJsonObject>& O, const TCHAR* Key)
{
	TArray<FString> Out;
	const TArray<TSharedPtr<FJsonValue>>* Arr;
	if (O.IsValid() && O->TryGetArrayField(Key, Arr))
	{
		for (const TSharedPtr<FJsonValue>& V : *Arr) Out.Add(V->AsString());
	}
	return Out;
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
			PlayerFace = Num(*Start, TEXT("face"), 0.f);
		}
		const TArray<TSharedPtr<FJsonValue>>* Arr;
		if ((*Markers)->TryGetArrayField(TEXT("portals"), Arr))
		{
			for (const TSharedPtr<FJsonValue>& V : *Arr)
			{
				const TSharedPtr<FJsonObject> O = V->AsObject();
				if (!O) continue;
				FLigaPortalDef P;
				P.Id = Str(O, TEXT("id"));
				P.Kind = Str(O, TEXT("kind"));
				P.Title = Str(O, TEXT("title"));
				P.Pos = Vec3(O);
				P.To = Vec3(O, TEXT("t"));
				P.ToFace = Num(O, TEXT("tface"), 0.f);
				P.Lines = StrArray(O, TEXT("lines"));
				Portals.Add(P);
			}
		}
		if ((*Markers)->TryGetArrayField(TEXT("places"), Arr))
		{
			for (const TSharedPtr<FJsonValue>& V : *Arr)
			{
				const TSharedPtr<FJsonObject> O = V->AsObject();
				if (!O) continue;
				FLigaPlaceDef P;
				P.Id = Str(O, TEXT("id"));
				P.Name = Str(O, TEXT("name"));
				O->TryGetBoolField(TEXT("indoor"), P.bIndoor);
				P.X0 = Num(O, TEXT("x0"), 0.f);
				P.X1 = Num(O, TEXT("x1"), 0.f);
				P.Y0 = Num(O, TEXT("y0"), 0.f);
				P.Y1 = Num(O, TEXT("y1"), 0.f);
				P.Z0 = Num(O, TEXT("z0"), -1.0e6f);
				P.Z1 = Num(O, TEXT("z1"), 1.0e6f);
				const TArray<TSharedPtr<FJsonValue>>* Lights;
				if (O->TryGetArrayField(TEXT("lights"), Lights))
				{
					for (const TSharedPtr<FJsonValue>& L : *Lights)
					{
						const TArray<TSharedPtr<FJsonValue>>& A = L->AsArray();
						if (A.Num() >= 4) P.Lights.Add(FVector4(A[0]->AsNumber(), A[1]->AsNumber(), A[2]->AsNumber(), A[3]->AsNumber()));
					}
				}
				Places.Add(P);
			}
		}
		if ((*Markers)->TryGetArrayField(TEXT("ambient"), Arr))
		{
			for (const TSharedPtr<FJsonValue>& V : *Arr)
			{
				const TSharedPtr<FJsonObject> O = V->AsObject();
				if (!O) continue;
				FLigaAmbientDef A;
				A.Species = (int32)Num(O, TEXT("species"), 0.f);
				A.Pos = Vec3(O);
				A.Radius = Num(O, TEXT("radius"), 3.f);
				A.Quest = Str(O, TEXT("quest"));
				double Swim = 0.0;
				if (O->TryGetNumberField(TEXT("swim_z"), Swim))
				{
					A.bSwim = true;
					A.SwimZ = (float)Swim;
				}
				if (A.Species > 0) Ambient.Add(A);
			}
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
				N.Face = Num(O, TEXT("face"), 0.f);
				const TArray<TSharedPtr<FJsonValue>>* Lines;
				if (O->TryGetArrayField(TEXT("lines"), Lines))
				{
					for (const TSharedPtr<FJsonValue>& L : *Lines) N.Lines.Add(L->AsString());
				}
				const TArray<TSharedPtr<FJsonValue>>* Route;
				if (O->TryGetArrayField(TEXT("route"), Route))
				{
					for (const TSharedPtr<FJsonValue>& R : *Route)
					{
						const TArray<TSharedPtr<FJsonValue>>& A = R->AsArray();
						if (A.Num() >= 2) N.Route.Add(FVector2D(A[0]->AsNumber(), A[1]->AsNumber()));
					}
				}
				O->TryGetBoolField(TEXT("loop"), N.bLoop);
				N.Speed = Num(O, TEXT("speed"), 1.2f);
				N.Pause = Num(O, TEXT("pause"), 2.f);
				const TSharedPtr<FJsonObject>* Tr;
				if (O->TryGetObjectField(TEXT("trainer"), Tr) && Tr->IsValid())
				{
					N.bTrainer = true;
					const TArray<TSharedPtr<FJsonValue>>* TeamArr;
					if ((*Tr)->TryGetArrayField(TEXT("team"), TeamArr))
					{
						for (const TSharedPtr<FJsonValue>& M : *TeamArr)
						{
							const TArray<TSharedPtr<FJsonValue>>& A = M->AsArray();
							if (A.Num() >= 2) N.Trainer.Team.Add(FIntPoint((int32)A[0]->AsNumber(), (int32)A[1]->AsNumber()));
						}
					}
					N.Trainer.Prize = (int32)Num(*Tr, TEXT("prize"), 0.f);
					N.Trainer.Before = StrArray(*Tr, TEXT("before"));
					N.Trainer.After = StrArray(*Tr, TEXT("after"));
					N.Trainer.Sight = Num(*Tr, TEXT("sight"), 6.f);
					N.Trainer.Class = Str(*Tr, TEXT("class"));
				}
				Npcs.Add(N);
			}
		}
	}
	const TArray<TSharedPtr<FJsonValue>>* WaterArr;
	if (Root->TryGetArrayField(TEXT("waters"), WaterArr))
	{
		for (const TSharedPtr<FJsonValue>& V : *WaterArr)
		{
			const TSharedPtr<FJsonObject> O = V->AsObject();
			if (!O) continue;
			FLigaWaterDef W;
			W.Center = FVector2D(Num(O, TEXT("x"), 0.f), Num(O, TEXT("y"), 0.f));
			W.Radius = FVector2D(Num(O, TEXT("rx"), 1.f), Num(O, TEXT("ry"), 1.f));
			W.Z = Num(O, TEXT("z"), 0.f);
			Waters.Add(W);
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
			O->TryGetStringField(TEXT("kind"), Z.Kind);
			O->TryGetStringField(TEXT("place"), Z.Place);
			Z.Pad = Num(O, TEXT("pad"), 3.5f);
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
	UE_LOG(LogLigaAssets, Log, TEXT("Layout: %d NPCs, %d zones, %d doors, %d places, %d instance kinds"), Npcs.Num(), Zones.Num(), Portals.Num(), Places.Num(), Instances.Num());
}
