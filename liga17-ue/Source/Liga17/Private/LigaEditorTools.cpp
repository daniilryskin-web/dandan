#include "LigaEditorTools.h"

#if WITH_EDITOR && LIGA_WITH_VRM4U
#include "VrmAssetListObject.h"
#include "VrmImporterBPFunctionLibrary.h"
#endif

bool ULigaEditorTools::CanImportVrmWithRetargeter()
{
#if WITH_EDITOR && LIGA_WITH_VRM4U
	return true;
#else
	return false;
#endif
}

UObject* ULigaEditorTools::ImportVrmWithRetargeter(const FString& SourceFile, const FString& DestinationPackagePath, bool bGenerateMipmaps)
{
#if WITH_EDITOR && LIGA_WITH_VRM4U
	FImportOptionData Options;
	Options.bGenerateRigIK = true;  // IK_<name>_Mannequin + RTG_<name>: the mannequin's animations retargeted onto the model
	Options.bMipmapGenerateMode = bGenerateMipmaps;
	Options.bBC7Mode = true;
	return UVrmImporterBPFunctionLibrary::ImportVRMFileWithOptions(SourceFile, DestinationPackagePath, Options);
#else
	return nullptr;
#endif
}
