#include "LigaGameInstance.h"

#include "Engine/Texture2D.h"
#include "HttpModule.h"
#include "ImageUtils.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Kismet/GameplayStatics.h"
#include "LigaData.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

DEFINE_LOG_CATEGORY_STATIC(LogLiga, Log, All);

namespace
{
	const TCHAR* GSaveSlot = TEXT("Liga17");
	const TCHAR* GHomeUrl = TEXT("https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/");
}

void ULigaGameInstance::Init()
{
	Super::Init();
	Rng.Initialize(FPlatformTime::Cycles());
	FLigaDatabase::Get();
	if (!LoadGame()) NewGame();
}

ULigaGameInstance* ULigaGameInstance::Get(const UObject* WorldContext)
{
	return WorldContext ? Cast<ULigaGameInstance>(UGameplayStatics::GetGameInstance(WorldContext)) : nullptr;
}

void ULigaGameInstance::NewGame()
{
	Data = FLigaGameData();
	Data.Bag.Add(TEXT("potion"), 2);
}

bool ULigaGameInstance::SaveGame()
{
	ULigaSaveGame* Save = Cast<ULigaSaveGame>(UGameplayStatics::CreateSaveGameObject(ULigaSaveGame::StaticClass()));
	Save->Data = Data;
	const bool bOk = UGameplayStatics::SaveGameToSlot(Save, GSaveSlot, 0);
	UE_LOG(LogLiga, Log, TEXT("Save %s"), bOk ? TEXT("ok") : TEXT("failed"));
	return bOk;
}

bool ULigaGameInstance::LoadGame()
{
	if (!HasSaveGame()) return false;
	ULigaSaveGame* Save = Cast<ULigaSaveGame>(UGameplayStatics::LoadGameFromSlot(GSaveSlot, 0));
	if (!Save) return false;
	Data = Save->Data;
	return true;
}

bool ULigaGameInstance::HasSaveGame() const
{
	return UGameplayStatics::DoesSaveGameExist(GSaveSlot, 0);
}

void ULigaGameInstance::GiveStarter(int32 Species)
{
	FLigaPokemon P = LigaRules::CreatePokemon(Species, 5, Rng, Data.NextUid++, 0);
	P.MetAt = TEXT("Паллет-таун");
	Data.Team.Add(P);
	Data.MarkCaught(Species);
	Data.SetFlag(TEXT("got_starter"));
	Data.AddItem(TEXT("poke-ball"), 5);
	Data.AddItem(TEXT("potion"), 3);
}

void ULigaGameInstance::HealTeam()
{
	for (FLigaPokemon& P : Data.Team) LigaRules::HealFully(P);
}

bool ULigaGameInstance::RollWild(const FString& Route, int32& OutSpecies, int32& OutLevel)
{
	// The route's table, plus its "@night" or "@day" table by the computer clock (owls and ghosts come out at night).
	TArray<FLigaEncounter> Table;
	const FLigaDatabase& Db = FLigaDatabase::Get();
	if (const TArray<FLigaEncounter>* Base = Db.Encounters(Route)) Table.Append(*Base);
	if (const TArray<FLigaEncounter>* Now = Db.Encounters(Route + (LigaRules::IsDaytime() ? TEXT("@day") : TEXT("@night")))) Table.Append(*Now);
	int32 Total = 0;
	for (const FLigaEncounter& E : Table) Total += E.Weight;
	if (Total <= 0) return false;
	int32 Roll = Rng.RandRange(0, Total - 1);
	for (const FLigaEncounter& E : Table)
	{
		if (Roll < E.Weight)
		{
			OutSpecies = E.Species;
			OutLevel = Rng.RandRange(E.MinLevel, E.MaxLevel);
			return true;
		}
		Roll -= E.Weight;
	}
	return false;
}

bool ULigaGameInstance::StartWildBattle(int32 Species, int32 Level, const FString& Place)
{
	Battle = FLigaBattle::StartWild(Data, Species, Level, Place, Rng.RandRange(1, MAX_int32 - 1));
	return Battle.IsValid();
}

bool ULigaGameInstance::StartTrainerBattle(const FString& Trainer, const TArray<FIntPoint>& Team, int32 Prize, const FString& Place)
{
	Battle = FLigaBattle::StartTrainer(Data, Trainer, Team, Prize, Place, Rng.RandRange(1, MAX_int32 - 1));
	return Battle.IsValid();
}

void ULigaGameInstance::EndBattle()
{
	Battle.Reset();
	SaveGame();
}

// ——— pictures ———

FString ULigaGameInstance::TextureKey(int32 Species, bool bShiny)
{
	return FString::Printf(TEXT("%s%d"), bShiny ? TEXT("s") : TEXT(""), Species);
}

UTexture2D* ULigaGameInstance::GetCachedTexture(int32 Species, bool bShiny) const
{
	const TObjectPtr<UTexture2D>* T = TextureCache.Find(TextureKey(Species, bShiny));
	return T ? T->Get() : nullptr;
}

UTexture2D* ULigaGameInstance::DecodeTexture(const TArray<uint8>& Bytes)
{
	UTexture2D* Tex = FImageUtils::ImportBufferAsTexture2D(Bytes);
	if (Tex)
	{
		Tex->SRGB = true;
		Tex->Filter = TF_Trilinear;
		Tex->LODGroup = TEXTUREGROUP_UI;
		Tex->UpdateResource();
	}
	return Tex;
}

void ULigaGameInstance::FinishTexture(const FString& Key, UTexture2D* Tex)
{
	if (Tex) TextureCache.Add(Key, Tex);
	TArray<FLigaTextureReady> Waiting;
	PendingTextures.RemoveAndCopyValue(Key, Waiting);
	for (FLigaTextureReady& D : Waiting) D.ExecuteIfBound(Tex);
}

void ULigaGameInstance::RequestPokemonTexture(int32 Species, bool bShiny, FLigaTextureReady Done)
{
	const FString Key = TextureKey(Species, bShiny);
	if (UTexture2D* Cached = GetCachedTexture(Species, bShiny))
	{
		Done.ExecuteIfBound(Cached);
		return;
	}
	if (TArray<FLigaTextureReady>* Waiting = PendingTextures.Find(Key))
	{
		Waiting->Add(Done);
		return;
	}
	PendingTextures.Add(Key).Add(Done);

	const FString CacheFile = FPaths::ProjectSavedDir() / TEXT("HomeCache") / (Key + TEXT(".png"));
	TArray<uint8> Bytes;
	if (FFileHelper::LoadFileToArray(Bytes, *CacheFile) && Bytes.Num() > 0)
	{
		FinishTexture(Key, DecodeTexture(Bytes));
		return;
	}
	const FString Url = FString::Printf(TEXT("%s%s%d.png"), GHomeUrl, bShiny ? TEXT("shiny/") : TEXT(""), Species);
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
	Req->SetURL(Url);
	Req->SetVerb(TEXT("GET"));
	TWeakObjectPtr<ULigaGameInstance> WeakThis(this);
	Req->OnProcessRequestComplete().BindLambda([WeakThis, Key, CacheFile](FHttpRequestPtr, FHttpResponsePtr Resp, bool bOk)
	{
		ULigaGameInstance* Self = WeakThis.Get();
		if (!Self) return;
		UTexture2D* Tex = nullptr;
		if (bOk && Resp.IsValid() && Resp->GetResponseCode() == 200)
		{
			const TArray<uint8>& Content = Resp->GetContent();
			FFileHelper::SaveArrayToFile(Content, *CacheFile);
			Tex = Self->DecodeTexture(Content);
		}
		else
		{
			UE_LOG(LogLiga, Warning, TEXT("Could not download %s"), *Key);
		}
		Self->FinishTexture(Key, Tex);
	});
	Req->ProcessRequest();
}
