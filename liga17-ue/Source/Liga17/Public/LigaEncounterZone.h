// Лига 17 — tall grass area: walking inside rolls wild encounters.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "LigaEncounterZone.generated.h"

class UBoxComponent;

UCLASS()
class LIGA17_API ALigaEncounterZone : public AActor
{
	GENERATED_BODY()

public:
	ALigaEncounterZone();

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UBoxComponent> Box;

	/** Encounter table id (FLigaDatabase::Encounters). */
	UPROPERTY(EditAnywhere)
	FString Route = TEXT("route1");

	/** Where the battle takes place, for the battle log ("Берег Паллет-тауна"). */
	UPROPERTY(EditAnywhere)
	FString Place = TEXT("Маршрут 1");
};
