// Лига 17 — owns the player's game data, the running battle and the Pokémon picture cache.
#pragma once

#include "CoreMinimal.h"
#include "Engine/GameInstance.h"
#include "LigaBattle.h"
#include "LigaPokemon.h"
#include "LigaGameInstance.generated.h"

class UTexture2D;

DECLARE_DELEGATE_OneParam(FLigaTextureReady, UTexture2D*);

UCLASS()
class LIGA17_API ULigaGameInstance : public UGameInstance
{
	GENERATED_BODY()

public:
	virtual void Init() override;

	static ULigaGameInstance* Get(const UObject* WorldContext);

	UPROPERTY()
	FLigaGameData Data;

	TUniquePtr<FLigaBattle> Battle;

	FRandomStream Rng;

	// ——— game flow ———
	void NewGame();
	bool SaveGame();
	bool LoadGame();
	bool HasSaveGame() const;
	bool HasStarter() const { return Data.Team.Num() > 0; }
	void GiveStarter(int32 Species);
	void HealTeam();

	/** Rolls a wild Pokémon for an encounter table (route id from layout.json). */
	bool RollWild(const FString& Route, int32& OutSpecies, int32& OutLevel);
	/** Starts a wild battle; false if the team cannot fight. */
	bool StartWildBattle(int32 Species, int32 Level, const FString& Place);
	void EndBattle();

	// ——— pictures ———
	/** HOME render of a species from the PokeAPI sprites repository (downloaded once, cached in Saved/HomeCache). */
	void RequestPokemonTexture(int32 Species, bool bShiny, FLigaTextureReady Done);
	UTexture2D* GetCachedTexture(int32 Species, bool bShiny) const;

private:
	UPROPERTY()
	TMap<FString, TObjectPtr<UTexture2D>> TextureCache;

	TMap<FString, TArray<FLigaTextureReady>> PendingTextures;

	static FString TextureKey(int32 Species, bool bShiny);
	UTexture2D* DecodeTexture(const TArray<uint8>& Bytes);
	void FinishTexture(const FString& Key, UTexture2D* Tex);
};
