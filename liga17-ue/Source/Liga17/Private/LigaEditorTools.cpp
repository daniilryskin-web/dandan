#include "LigaEditorTools.h"

#include "UObject/UnrealType.h"

DEFINE_LOG_CATEGORY_STATIC(LogLigaEditorTools, Log, All);

#if WITH_EDITOR
// VRM4U is an optional plugin and is reached by name, like everywhere else in the project: linking it made the game
// module fail to load, because the project's modules load before the plugin's.
namespace
{
	struct FVrmImport
	{
		UObject* Library = nullptr;
		UFunction* Function = nullptr;
		FStructProperty* Options = nullptr;
		int32 RigIKOffset = INDEX_NONE;  // FImportOptionData::bGenerateRigIK, a plain C++ member without reflection
	};

	FVrmImport FindVrmImport()
	{
		FVrmImport R;
		UClass* Lib = FindObject<UClass>(nullptr, TEXT("/Script/VRM4UImporter.VrmImporterBPFunctionLibrary"));
		R.Function = Lib ? Lib->FindFunctionByName(TEXT("ImportVRMFileWithOptions")) : nullptr;
		if (!R.Function) return R;
		R.Library = Lib->GetDefaultObject();
		for (TFieldIterator<FProperty> It(R.Function); It && It->HasAnyPropertyFlags(CPF_Parm); ++It)
		{
			if (FStructProperty* S = CastField<FStructProperty>(*It)) R.Options = S;
		}
		if (!R.Options) return R;
		// In VrmUtil.h bGenerateRigIK sits between two reflected bools: bGenerateIKBone and bSkipPhysics.
		// Only when they are exactly two bytes apart is the byte between them surely bGenerateRigIK.
		FBoolProperty* Before = FindFProperty<FBoolProperty>(R.Options->Struct, TEXT("bGenerateIKBone"));
		FBoolProperty* After = FindFProperty<FBoolProperty>(R.Options->Struct, TEXT("bSkipPhysics"));
		if (Before && After && Before->IsNativeBool() && After->IsNativeBool()
			&& After->GetOffset_ForInternal() == Before->GetOffset_ForInternal() + 2)
		{
			R.RigIKOffset = Before->GetOffset_ForInternal() + 1;
		}
		return R;
	}

	void SetBool(UScriptStruct* Struct, void* Data, const TCHAR* Name, bool bValue)
	{
		if (FBoolProperty* P = FindFProperty<FBoolProperty>(Struct, Name)) P->SetPropertyValue_InContainer(Data, bValue);
	}
}
#endif

bool ULigaEditorTools::CanImportVrmWithRetargeter()
{
#if WITH_EDITOR
	const FVrmImport Vrm = FindVrmImport();
	return Vrm.Options && Vrm.RigIKOffset != INDEX_NONE;
#else
	return false;
#endif
}

UObject* ULigaEditorTools::ImportVrmWithRetargeter(const FString& SourceFile, const FString& DestinationPackagePath, bool bGenerateMipmaps)
{
#if WITH_EDITOR
	const FVrmImport Vrm = FindVrmImport();
	if (!Vrm.Options || Vrm.RigIKOffset == INDEX_NONE)
	{
		UE_LOG(LogLigaEditorTools, Warning, TEXT("VRM4U import with retargeter is not available (plugin missing or changed)"));
		return nullptr;
	}
	UFunction* Func = Vrm.Function;
	uint8* Parms = static_cast<uint8*>(FMemory::Malloc(FMath::Max<int32>(1, Func->ParmsSize), Func->GetMinAlignment()));
	FMemory::Memzero(Parms, Func->ParmsSize);
	UObject* Result = nullptr;
	int32 StringIndex = 0;
	for (TFieldIterator<FProperty> It(Func); It && It->HasAnyPropertyFlags(CPF_Parm); ++It)
	{
		It->InitializeValue_InContainer(Parms);  // the options struct gets its C++ defaults here
		if (FStrProperty* S = CastField<FStrProperty>(*It))
		{
			S->SetPropertyValue_InContainer(Parms, StringIndex++ == 0 ? SourceFile : DestinationPackagePath);
		}
	}
	uint8* Options = Vrm.Options->ContainerPtrToValuePtr<uint8>(Parms);
	SetBool(Vrm.Options->Struct, Options, TEXT("bMipmapGenerateMode"), bGenerateMipmaps);
	SetBool(Vrm.Options->Struct, Options, TEXT("bBC7Mode"), true);
	*reinterpret_cast<bool*>(Options + Vrm.RigIKOffset) = true;  // IK_<name>_Mannequin + RTG_<name>
	Vrm.Library->ProcessEvent(Func, Parms);
	for (TFieldIterator<FProperty> It(Func); It && It->HasAnyPropertyFlags(CPF_Parm); ++It)
	{
		if (It->HasAnyPropertyFlags(CPF_ReturnParm))
		{
			if (FObjectProperty* O = CastField<FObjectProperty>(*It)) Result = O->GetObjectPropertyValue_InContainer(Parms);
		}
		It->DestroyValue_InContainer(Parms);
	}
	FMemory::Free(Parms);
	return Result;
#else
	return nullptr;
#endif
}
