using UnrealBuildTool;

public class Liga17EditorTarget : TargetRules
{
	public Liga17EditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("Liga17");
	}
}
