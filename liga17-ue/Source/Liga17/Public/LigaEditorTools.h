// Лига 17 — editor helpers called by Content/Python/liga_setup.py.
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "LigaEditorTools.generated.h"

UCLASS()
class LIGA17_API ULigaEditorTools : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** True when VRM4U is loaded and ImportVrmWithRetargeter can ask it for the retargeter. */
	UFUNCTION(BlueprintCallable, Category = "Liga")
	static bool CanImportVrmWithRetargeter();

	/** Imports a .vrm with VRM4U the way its import dialog does, including the IK rigs and the RTG_<name> retargeter from the
	 *  UE5 mannequin. VRM4U's own scripted import cannot ask for those: the option is not visible to Python.
	 *  Returns the VRM asset list, or nullptr. The new assets are not saved. */
	UFUNCTION(BlueprintCallable, Category = "Liga")
	static UObject* ImportVrmWithRetargeter(const FString& SourceFile, const FString& DestinationPackagePath, bool bGenerateMipmaps);
};
