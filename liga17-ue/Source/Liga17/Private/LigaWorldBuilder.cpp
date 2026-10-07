#include "LigaWorldBuilder.h"

#include "Components/BoxComponent.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Components/PointLightComponent.h"
#include "Materials/Material.h"
#include "Components/PostProcessComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/Light.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Components/SphereComponent.h"
#include "LigaAssets.h"
#include "LigaEncounterZone.h"
#include "LigaFollower.h"
#include "LigaInteractable.h"
#include "LigaGameInstance.h"
#include "GameFramework/PlayerController.h"
#include "LigaNPC.h"

DEFINE_LOG_CATEGORY_STATIC(LogLigaWorld, Log, All);

ALigaWorldBuilder::ALigaWorldBuilder()
{
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent->SetMobility(EComponentMobility::Static);
	PrimaryActorTick.bCanEverTick = false;
}

void ALigaWorldBuilder::BeginPlay()
{
	Super::BeginPlay();
	FindAxes();
	EnsureLighting();
	// Ground traces first (zones, doors, NPCs), then the trees that would otherwise catch them.
	SpawnZones();
	SpawnDoors();
	SpawnNpcs();
	SpawnRoomLights();
	SpawnAmbient();
	PlacePlayer();
	SpawnFoliage();
}

void ALigaWorldBuilder::PlacePlayer()
{
	APlayerController* PC = GetWorld()->GetFirstPlayerController();
	APawn* Pawn = PC ? PC->GetPawn() : nullptr;
	if (!Pawn) return;
	const ULigaGameInstance* GI = ULigaGameInstance::Get(this);
	FVector Where = PlayerStartWorld();
	float Yaw = PlayerStartYaw();
	if (GI && GI->Data.bHasPosition)
	{
		Where = GI->Data.PlayerLocation + FVector(0, 0, 20.f);
		Yaw = GI->Data.PlayerYaw;
	}
	Pawn->TeleportTo(Where, FRotator(0.f, Yaw, 0.f));
	PC->SetControlRotation(FRotator(-12.f, Yaw, 0.f));
}

void ALigaWorldBuilder::FindAxes()
{
	// The Blender scene contains three hidden marker cubes: at (0,0,-20), (50,0,-20) and (0,50,-20).
	// The setup script tags them after importing; from them we know exactly how the scene landed in Unreal.
	AActor* O = nullptr;
	AActor* PX = nullptr;
	AActor* PY = nullptr;
	for (TActorIterator<AActor> It(GetWorld()); It; ++It)
	{
		if (It->ActorHasTag(TEXT("MARKER_ORIGIN"))) O = *It;
		else if (It->ActorHasTag(TEXT("MARKER_PX"))) PX = *It;
		else if (It->ActorHasTag(TEXT("MARKER_PY"))) PY = *It;
	}
	if (O && PX && PY)
	{
		AxisX = (PX->GetActorLocation() - O->GetActorLocation()) / 50.f;
		AxisY = (PY->GetActorLocation() - O->GetActorLocation()) / 50.f;
		AxisZ = FVector(0.f, 0.f, AxisX.Size());
		Origin = O->GetActorLocation() + AxisZ * 20.f;
		UE_LOG(LogLigaWorld, Log, TEXT("Layout axes from markers: X=%s Y=%s"), *AxisX.ToString(), *AxisY.ToString());
	}
	else
	{
		UE_LOG(LogLigaWorld, Warning, TEXT("Layout markers not found — assuming the default glTF import orientation"));
	}
}

FVector ALigaWorldBuilder::ToWorld(const FVector& B) const
{
	return Origin + AxisX * B.X + AxisY * B.Y + AxisZ * B.Z;
}

FVector ALigaWorldBuilder::ToBlender(const FVector& W) const
{
	const FVector D = W - Origin;
	// Solve D.xy = a * AxisX.xy + b * AxisY.xy.
	const double Det = AxisX.X * AxisY.Y - AxisX.Y * AxisY.X;
	if (FMath::Abs(Det) < KINDA_SMALL_NUMBER) return FVector::ZeroVector;
	const double A = (D.X * AxisY.Y - D.Y * AxisY.X) / Det;
	const double B = (AxisX.X * D.Y - AxisX.Y * D.X) / Det;
	return FVector(A, B, D.Z / FMath::Max(1.0, (double)AxisZ.Z));
}

float ALigaWorldBuilder::ToWorldYaw(float BlenderYaw) const
{
	// Rotate the Blender +X direction by the yaw and map it.
	const FVector Dir = AxisX * FMath::Cos(BlenderYaw) + AxisY * FMath::Sin(BlenderYaw);
	return Dir.Rotation().Yaw;
}

FVector ALigaWorldBuilder::Ground(const FVector& W, float Up) const
{
	FHitResult Hit;
	FCollisionQueryParams Q(SCENE_QUERY_STAT(LigaWorldGround), true);
	for (TActorIterator<APawn> It(GetWorld()); It; ++It) Q.AddIgnoredActor(*It);
	if (GetWorld()->LineTraceSingleByChannel(Hit, W + FVector(0, 0, Up), W - FVector(0, 0, 5000.f), ECC_Visibility, Q))
	{
		return Hit.ImpactPoint;
	}
	return W;
}

FVector ALigaWorldBuilder::GroundAtLayout(const FVector& B, bool bLow) const
{
	if (FLigaLayout::IsIndoorPoint(B)) return Ground(ToWorld(B + FVector(0.f, 0.f, 1.2f)), 0.f);
	// Doors: start just above the ground, or the trace lands on the porch roof over the entrance.
	if (bLow) return Ground(ToWorld(FVector(B.X, B.Y, B.Z + 1.5f)), 0.f);
	return Ground(ToWorld(FVector(B.X, B.Y, 0.f)));
}

float ALigaWorldBuilder::SeaLevelZ() const
{
	return ToWorld(FVector(0.f, 0.f, FLigaLayout::Get().SeaLevel)).Z;
}

float ALigaWorldBuilder::WaterZAt(const FVector& World) const
{
	const FLigaLayout& L = FLigaLayout::Get();
	return ToWorld(FVector(0.f, 0.f, L.WaterLevelAt(ToBlender(World)))).Z;
}

const FLigaPlaceDef* ALigaWorldBuilder::PlaceAtWorld(const FVector& W) const
{
	return FLigaLayout::Get().PlaceAt(ToBlender(W));
}

FVector ALigaWorldBuilder::PlayerStartWorld() const
{
	return GroundAtLayout(FLigaLayout::Get().PlayerStart) + FVector(0, 0, 100.f);
}

float ALigaWorldBuilder::PlayerStartYaw() const
{
	return ToWorldYaw(FLigaLayout::Get().PlayerFace);
}

void ALigaWorldBuilder::EnsureLighting()
{
	UWorld* W = GetWorld();
	auto Has = [W](UClass* C)
	{
		for (TActorIterator<AActor> It(W, C); It; ++It) return true;
		return false;
	};
	FActorSpawnParameters P;
	P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	// Everything is created as components of this actor and configured before registration.
	if (!Has(ADirectionalLight::StaticClass()))
	{
		UDirectionalLightComponent* L = NewObject<UDirectionalLightComponent>(this, TEXT("Sun"));
		L->SetupAttachment(RootComponent);
		L->SetMobility(EComponentMobility::Movable);
		L->SetWorldRotation(FRotator(-38.f, 215.f, 0.f));
		L->Intensity = 9.5f;
		L->LightColor = FColor(255, 242, 219);
		L->bAtmosphereSunLight = true;
		L->DynamicShadowDistanceMovableLight = 20000.f;
		L->LightSourceAngle = 1.2f;
		L->CastShadows = true;
		L->RegisterComponent();
	}
	if (!Has(ASkyLight::StaticClass()))
	{
		USkyLightComponent* S = NewObject<USkyLightComponent>(this, TEXT("SkyLight"));
		S->SetupAttachment(RootComponent);
		S->SetMobility(EComponentMobility::Movable);
		S->bRealTimeCapture = true;
		S->Intensity = 1.15f;
		S->RegisterComponent();
	}
	// Sky atmosphere, clouds, fog and post processing are plain components on this actor.
	bool bAtmo = false;
	bool bClouds = false;
	bool bFog = false;
	bool bPost = false;
	for (TActorIterator<AActor> It(W); It; ++It)
	{
		bAtmo |= It->FindComponentByClass<USkyAtmosphereComponent>() != nullptr;
		bClouds |= It->FindComponentByClass<UVolumetricCloudComponent>() != nullptr;
		bFog |= It->FindComponentByClass<UExponentialHeightFogComponent>() != nullptr;
		bPost |= It->IsA<APostProcessVolume>();
	}
	if (!bAtmo)
	{
		USkyAtmosphereComponent* A = NewObject<USkyAtmosphereComponent>(this, TEXT("Atmosphere"));
		A->SetupAttachment(RootComponent);
		A->RegisterComponent();
	}
	if (!bClouds)
	{
		UVolumetricCloudComponent* C = NewObject<UVolumetricCloudComponent>(this, TEXT("Clouds"));
		C->SetupAttachment(RootComponent);
		if (UMaterialInterface* M = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud_Inst.m_SimpleVolumetricCloud_Inst"), nullptr, LOAD_NoWarn | LOAD_Quiet))
		{
			C->SetMaterial(M);
		}
		C->SetLayerBottomAltitude(3.f);
		C->SetLayerHeight(6.f);
		C->RegisterComponent();
	}
	if (!bFog)
	{
		UExponentialHeightFogComponent* F = NewObject<UExponentialHeightFogComponent>(this, TEXT("Fog"));
		F->SetupAttachment(RootComponent);
		F->SetFogDensity(0.006f);
		F->SetFogHeightFalloff(0.12f);
		F->SetVolumetricFog(true);
		F->SetVolumetricFogScatteringDistribution(0.4f);
		F->RegisterComponent();
	}
	if (!bPost)
	{
		UPostProcessComponent* PP = NewObject<UPostProcessComponent>(this, TEXT("Post"));
		PP->SetupAttachment(RootComponent);
		PP->bUnbound = true;
		FPostProcessSettings& S = PP->Settings;
		S.bOverride_AutoExposureMethod = true;
		S.AutoExposureMethod = EAutoExposureMethod::AEM_Histogram;
		S.bOverride_AutoExposureBias = true;
		S.AutoExposureBias = 0.4f;
		S.bOverride_ColorSaturation = true;
		S.ColorSaturation = FVector4(1.12f, 1.12f, 1.12f, 1.f);
		S.bOverride_ColorContrast = true;
		S.ColorContrast = FVector4(1.04f, 1.04f, 1.04f, 1.f);
		S.bOverride_BloomIntensity = true;
		S.BloomIntensity = 0.55f;
		S.bOverride_VignetteIntensity = true;
		S.VignetteIntensity = 0.25f;
		S.bOverride_AmbientOcclusionIntensity = true;
		S.AmbientOcclusionIntensity = 0.6f;
		PP->RegisterComponent();
	}
}

void ALigaWorldBuilder::SpawnFoliage()
{
	const FLigaLayout& L = FLigaLayout::Get();
	for (const TPair<FString, TArray<FLigaInstance>>& KV : L.Instances)
	{
		UStaticMesh* Mesh = FLigaAssets::Get().KitMesh(KV.Key);
		if (!Mesh)
		{
			UE_LOG(LogLigaWorld, Warning, TEXT("Kit mesh %s not imported"), *KV.Key);
			continue;
		}
		const bool bGrass = KV.Key.StartsWith(TEXT("grass")) || KV.Key.StartsWith(TEXT("flower"));
		const bool bTree = KV.Key.StartsWith(TEXT("tree")) || KV.Key == TEXT("pine");
		UHierarchicalInstancedStaticMeshComponent* H = NewObject<UHierarchicalInstancedStaticMeshComponent>(this, *FString::Printf(TEXT("HISM_%s"), *KV.Key));
		H->SetupAttachment(RootComponent);
		H->SetStaticMesh(Mesh);
		// Movable: these are spawned at runtime, and Static meshes with no built lighting render black.
		H->SetMobility(EComponentMobility::Movable);
		if (bGrass)
		{
			H->SetCollisionEnabled(ECollisionEnabled::NoCollision);
			H->SetCullDistances(KV.Key == TEXT("grass_short") ? 3500 : 6000, KV.Key == TEXT("grass_short") ? 5000 : 9000);
			H->SetCastShadow(KV.Key != TEXT("grass_short"));
		}
		else
		{
			H->SetCollisionProfileName(TEXT("BlockAll"));
		}
		H->RegisterComponent();
		TArray<FTransform> Xf;
		Xf.Reserve(KV.Value.Num());
		for (const FLigaInstance& I : KV.Value)
		{
			const FVector Pos = ToWorld(I.Pos) - AxisZ * (bTree ? 0.15f : 0.02f);
			const FRotator Rot(0.f, ToWorldYaw(I.Yaw), 0.f);
			Xf.Add(FTransform(Rot, Pos, FVector(I.Scale)));
		}
		H->AddInstances(Xf, false, true);
		Foliage.Add(H);
		// One line per material in Saved/Logs/Liga17.log: grey foliage means a material that cannot draw instances.
		for (int32 i = 0; i < H->GetNumMaterials(); ++i)
		{
			UMaterialInterface* Mi = H->GetMaterial(i);
			const UMaterial* Base = Mi ? Mi->GetMaterial() : nullptr;
			UE_LOG(LogLigaWorld, Log, TEXT("Foliage %s slot %d: %s (instancing %d, Nanite %d)"), *KV.Key, i,
				Mi ? *Mi->GetPathName() : TEXT("none"), Base ? int32(Base->bUsedWithInstancedStaticMeshes) : -1, int32(Mesh->IsNaniteEnabled()));
		}
	}
}

void ALigaWorldBuilder::SpawnZones()
{
	for (const FLigaZoneDef& Z : FLigaLayout::Get().Zones)
	{
		const FVector A = ToWorld(FVector(Z.X0, Z.Y0, 0.f));
		const FVector B = ToWorld(FVector(Z.X1, Z.Y1, 0.f));
		const FVector C = Ground((A + B) * 0.5f);
		FActorSpawnParameters P;
		P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		ALigaEncounterZone* Zone = GetWorld()->SpawnActor<ALigaEncounterZone>(C, FRotator::ZeroRotator, P);
		const FVector Ext = (B - A).GetAbs() * 0.5f;
		// The margin covers the wiggle of Route 1 (its grass follows the winding road).
		const float Pad = Z.Pad * (float)AxisX.Size();
		Zone->Box->SetBoxExtent(FVector(Ext.X + Pad, Ext.Y + Pad, 400.f));
		Zone->Route = Z.Route.IsEmpty() ? TEXT("route1") : Z.Route;
		Zone->Place = Z.Place.IsEmpty() ? TEXT("Маршрут 1") : Z.Place;
	}
}

void ALigaWorldBuilder::SpawnDoors()
{
	const FLigaLayout& L = FLigaLayout::Get();
	FActorSpawnParameters P;
	P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	// Doors into the rooms and back out, and service spots such as the Poké Center computer.
	TSet<FString> WithRooms;
	for (const FLigaPortalDef& Def : L.Portals)
	{
		const FVector W = GroundAtLayout(Def.Pos, true) + FVector(0, 0, 80.f);
		ALigaDoor* Door = GetWorld()->SpawnActor<ALigaDoor>(W, FRotator::ZeroRotator, P);
		if (!Door) continue;
		Door->Title = Def.Title;
		Door->SpotId = Def.Id;
		Door->Lines = Def.Lines;
		WithRooms.Add(Def.Id);
		if (Def.Kind == TEXT("enter") || Def.Kind == TEXT("exit"))
		{
			Door->Kind = ELigaDoorKind::Portal;
			Door->bExit = Def.Kind == TEXT("exit");
			Door->bWalkIn = true;
			Door->Target = GroundAtLayout(Def.To, true) + FVector(0, 0, 95.f);
			Door->TargetYaw = ToWorldYaw(Def.ToFace);
		}
		else if (Def.Kind == TEXT("train"))
		{
			Door->Kind = ELigaDoorKind::Train;
			Door->Target = GroundAtLayout(Def.To, true) + FVector(0, 0, 95.f);
			Door->TargetYaw = ToWorldYaw(Def.ToFace);
		}
		else if (Def.Kind == TEXT("fishing"))
		{
			Door->Kind = ELigaDoorKind::Fishing;
		}
		else if (Def.Kind == TEXT("sign"))
		{
			Door->Kind = ELigaDoorKind::Sign;
		}
		else if (Def.Kind == TEXT("house"))
		{
			Door->Kind = ELigaDoorKind::House;
		}
		else
		{
			Door->Kind = ELigaDoorKind::Pc;
		}
	}
	// Houses you cannot enter: knocking gets an answer through the door.
	struct FDoorInfo { const TCHAR* Key; const TCHAR* Title; TArray<FString> Lines; };
	const TArray<FDoorInfo> Infos = {
		{TEXT("RivalHouse"), TEXT("Дом Гэри"), {TEXT("Дейзи: Гэри? Он где-то на улице, хвастается перед всеми."), TEXT("Хочешь, я расскажу тебе о покемонах? В высокой траве живут дикие покемоны!")}},
		{TEXT("RivalTower"), TEXT("Башня"), {TEXT("Заперто. На двери табличка: «Обсерватория. Не беспокоить».")}},
		{TEXT("NeighbourHouse"), TEXT("Дом соседей"), {TEXT("Изнутри доносится: «Покемоны — лучшие друзья человека!»")}},
		{TEXT("PlayerHouse"), TEXT("Ваш дом"), {}},
		{TEXT("OakLab"), TEXT("Лаборатория Оука"), {}},
	};
	for (const FDoorInfo& Info : Infos)
	{
		const FVector2D* D = L.Doors.Find(Info.Key);
		if (!D || WithRooms.Contains(Info.Key)) continue;
		const FVector W = Ground(ToWorld(FVector(D->X, D->Y, 0.f))) + FVector(0, 0, 80.f);
		ALigaDoor* Door = GetWorld()->SpawnActor<ALigaDoor>(W, FRotator::ZeroRotator, P);
		if (!Door) continue;
		// An old layout.json without rooms: the house and the lab work from their doors as before.
		Door->Kind = FString(Info.Key) == TEXT("PlayerHouse") ? ELigaDoorKind::Home : FString(Info.Key) == TEXT("OakLab") ? ELigaDoorKind::Lab : ELigaDoorKind::House;
		Door->Title = Info.Title;
		Door->Lines = Info.Lines;
	}
}

void ALigaWorldBuilder::SpawnNpcs()
{
	for (const FLigaNpcDef& N : FLigaLayout::Get().Npcs)
	{
		const FVector W = GroundAtLayout(N.Pos) + FVector(0, 0, 92.f);
		FActorSpawnParameters P;
		P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AdjustIfPossibleButAlwaysSpawn;
		P.bDeferConstruction = true;
		ALigaNPC* Npc = GetWorld()->SpawnActor<ALigaNPC>(ALigaNPC::StaticClass(), W, FRotator(0.f, ToWorldYaw(N.Face), 0.f), P);
		if (!Npc) continue;
		Npc->Configure(N.Id, N.Name, N.Look, N.Lines);
		if (N.Route.Num() >= 2)
		{
			TArray<FVector> Points;
			for (const FVector2D& R : N.Route) Points.Add(GroundAtLayout(FVector(R.X, R.Y, N.Pos.Z)) + FVector(0, 0, 92.f));
			Npc->SetRoute(Points, N.bLoop, N.Speed * (float)AxisX.Size(), N.Pause);
		}
		if (N.bTrainer) Npc->SetTrainer(N.Trainer.Sight * (float)AxisX.Size());
		Npc->FinishSpawning(FTransform(FRotator(0.f, ToWorldYaw(N.Face), 0.f), W));
	}
}

void ALigaWorldBuilder::SpawnRoomLights()
{
	for (const FLigaPlaceDef& Place : FLigaLayout::Get().Places)
	{
		for (const FVector4& L : Place.Lights)
		{
			UPointLightComponent* C = NewObject<UPointLightComponent>(this);
			C->SetupAttachment(RootComponent);
			C->SetMobility(EComponentMobility::Movable);
			C->SetWorldLocation(ToWorld(FVector(L.X, L.Y, L.Z)));
			C->SetIntensityUnits(ELightUnits::Candelas);
			C->SetIntensity((float)L.W);
			C->SetAttenuationRadius(1100.f);
			C->SetSourceRadius(25.f);
			C->SetLightColor(FLinearColor(1.f, 0.93f, 0.84f));
			C->SetCastShadows(true);
			C->RegisterComponent();
			RoomLights.Add(C);
		}
	}
}

void ALigaWorldBuilder::SpawnAmbient()
{
	for (const FLigaAmbientDef& A : FLigaLayout::Get().Ambient)
	{
		const FVector W = GroundAtLayout(A.Pos);
		FActorSpawnParameters P;
		P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		ALigaFollower* Mon = GetWorld()->SpawnActor<ALigaFollower>(W, FRotator(0.f, FMath::FRandRange(0.f, 360.f), 0.f), P);
		if (!Mon) continue;
		// Swimmers float on their pond or the sea instead of walking on its bottom.
		const float SwimZ = A.bSwim ? (float)ToWorld(FVector(0.f, 0.f, A.SwimZ)).Z : 0.f;
		if (!Mon->SetupAmbient(A.Species, W, A.Radius * (float)AxisX.Size(), A.Quest, A.bSwim, SwimZ)) Mon->Destroy();
	}
}
