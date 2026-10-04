using System.IO;
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

		// VRM4U is optional. When it is in Plugins/VRM4U, the editor links it so that the setup script can import the anime
		// characters together with their animation retargeters (ULigaEditorTools). The game itself only uses it by name.
		bool bVrm4u = Target.bBuildEditor && File.Exists(Path.Combine(ModuleDirectory, "..", "..", "Plugins", "VRM4U", "VRM4U.uplugin"));
		if (bVrm4u)
		{
			PrivateDependencyModuleNames.AddRange(new string[] { "VRM4U", "VRM4UImporter" });
		}
		PrivateDefinitions.Add("LIGA_WITH_VRM4U=" + (bVrm4u ? "1" : "0"));
	}
}
