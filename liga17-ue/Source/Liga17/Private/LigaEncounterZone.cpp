#include "LigaEncounterZone.h"

#include "Components/BoxComponent.h"

ALigaEncounterZone::ALigaEncounterZone()
{
	Box = CreateDefaultSubobject<UBoxComponent>(TEXT("Box"));
	Box->SetCollisionProfileName(TEXT("OverlapAllDynamic"));
	Box->SetGenerateOverlapEvents(true);
	Box->SetBoxExtent(FVector(400.f, 400.f, 300.f));
	RootComponent = Box;
}
