using UnrealBuildTool;

public class Liga17 : ModuleRules
{
	public Liga17(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core", "CoreUObject", "Engine", "InputCore", "EnhancedInput",
			"Slate", "SlateCore", "UMG",
			"HTTP", "ImageWrapper", "Json", "JsonUtilities", "ProceduralMeshComponent",
		});
	}
}
