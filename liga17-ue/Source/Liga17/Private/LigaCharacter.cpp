#include "LigaCharacter.h"

#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "EngineUtils.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "LigaAssets.h"
#include "LigaEncounterZone.h"
#include "LigaInteractable.h"
#include "LigaPlayerController.h"

DEFINE_LOG_CATEGORY_STATIC(LogLigaChar, Log, All);

// ——— visuals shared by the player and NPCs ———

void LigaVisuals::SetupBody(ACharacter* Character, USkeletalMeshComponent* VrmMesh, const FString& VrmAssetList)
{
	USkeletalMeshComponent* Body = Character->GetMesh();
	const FLigaAssets& A = FLigaAssets::Get();
	if (USkeletalMesh* Mesh = A.LoadCharacterMesh())
	{
		Body->SetSkeletalMesh(Mesh);
		if (UClass* Anim = A.LoadCharacterAnimClass()) Body->SetAnimInstanceClass(Anim);
	}
	else
	{
		UE_LOG(LogLigaChar, Warning, TEXT("Mannequin not found: add the Third Person content pack (see Docs/README_RU.md)"));
	}
	if (!VrmMesh || VrmAssetList.IsEmpty()) return;

	// VRoid model through VRM4U: copy the mannequin's pose every frame (UVrmAnimInstanceCopy), hide the mannequin.
	UObject* AssetList = LoadObject<UObject>(nullptr, *VrmAssetList, nullptr, LOAD_NoWarn | LOAD_Quiet);
	UClass* CopyClass = LoadClass<UAnimInstance>(nullptr, TEXT("/Script/VRM4U.VrmAnimInstanceCopy"), nullptr, LOAD_NoWarn | LOAD_Quiet);
	if (!AssetList || !CopyClass)
	{
		UE_LOG(LogLigaChar, Warning, TEXT("VRM model or VRM4U plugin missing (%s) — using the mannequin"), *VrmAssetList);
		return;
	}
	USkeletalMesh* VrmSkel = nullptr;
	if (FObjectProperty* P = FindFProperty<FObjectProperty>(AssetList->GetClass(), TEXT("SkeletalMesh")))
	{
		VrmSkel = Cast<USkeletalMesh>(P->GetObjectPropertyValue_InContainer(AssetList));
	}
	if (!VrmSkel)
	{
		UE_LOG(LogLigaChar, Warning, TEXT("VRM asset list has no skeletal mesh: %s"), *VrmAssetList);
		return;
	}
	VrmMesh->SetSkeletalMesh(VrmSkel);
	VrmMesh->SetAnimInstanceClass(CopyClass);
	if (UAnimInstance* Inst = VrmMesh->GetAnimInstance())
	{
		if (FObjectProperty* P = FindFProperty<FObjectProperty>(Inst->GetClass(), TEXT("DstVrmAssetList")))
		{
			P->SetObjectPropertyValue_InContainer(Inst, AssetList);
		}
		if (FObjectProperty* P = FindFProperty<FObjectProperty>(Inst->GetClass(), TEXT("SrcSkeletalMeshComponent")))
		{
			P->SetObjectPropertyValue_InContainer(Inst, Body);
		}
	}
	VrmMesh->SetVisibility(true);
	Body->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
	Body->SetVisibility(false);
}

// ——— player ———

ALigaCharacter::ALigaCharacter()
{
	PrimaryActorTick.bCanEverTick = true;
	GetCapsuleComponent()->InitCapsuleSize(34.f, 88.f);
	bUseControllerRotationPitch = false;
	bUseControllerRotationYaw = false;
	bUseControllerRotationRoll = false;

	UCharacterMovementComponent* Move = GetCharacterMovement();
	Move->bOrientRotationToMovement = true;
	Move->RotationRate = FRotator(0.f, 600.f, 0.f);
	Move->MaxWalkSpeed = 420.f;
	Move->JumpZVelocity = 520.f;
	Move->AirControl = 0.35f;
	Move->BrakingDecelerationWalking = 1800.f;
	Move->MaxStepHeight = 50.f;
	Move->SetWalkableFloorAngle(50.f);

	CameraBoom = CreateDefaultSubobject<USpringArmComponent>(TEXT("CameraBoom"));
	CameraBoom->SetupAttachment(RootComponent);
	CameraBoom->TargetArmLength = 430.f;
	CameraBoom->SocketOffset = FVector(0.f, 35.f, 70.f);
	CameraBoom->bUsePawnControlRotation = true;
	CameraBoom->bEnableCameraLag = true;
	CameraBoom->CameraLagSpeed = 12.f;
	CameraBoom->ProbeSize = 14.f;

	FollowCamera = CreateDefaultSubobject<UCameraComponent>(TEXT("FollowCamera"));
	FollowCamera->SetupAttachment(CameraBoom, USpringArmComponent::SocketName);
	FollowCamera->bUsePawnControlRotation = false;
	FollowCamera->SetFieldOfView(62.f);

	GetMesh()->SetRelativeLocationAndRotation(FVector(0.f, 0.f, -90.f), FRotator(0.f, -90.f, 0.f));
	VrmMesh = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("VrmMesh"));
	VrmMesh->SetupAttachment(GetMesh());
	VrmMesh->SetVisibility(false);
	VrmMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
}

void ALigaCharacter::BeginPlay()
{
	Super::BeginPlay();
	LigaVisuals::SetupBody(this, VrmMesh, FLigaAssets::Get().PlayerVrm);
	LastPos = GetActorLocation();
	if (AController* C = GetController())
	{
		C->SetControlRotation(FRotator(-12.f, GetActorRotation().Yaw, 0.f));
	}
}

ALigaPlayerController* ALigaCharacter::LigaPC() const
{
	return Cast<ALigaPlayerController>(GetController());
}

void ALigaCharacter::BuildInput()
{
	// Input assets are created at runtime so the project needs no input .uasset files.
	Mapping = NewObject<UInputMappingContext>(this, TEXT("LigaMapping"));
	auto MakeAction = [this](const TCHAR* Name, EInputActionValueType Type)
	{
		UInputAction* A = NewObject<UInputAction>(this, Name);
		A->ValueType = Type;
		return A;
	};
	MoveAction = MakeAction(TEXT("IA_Move"), EInputActionValueType::Axis2D);
	LookAction = MakeAction(TEXT("IA_Look"), EInputActionValueType::Axis2D);
	JumpAction = MakeAction(TEXT("IA_Jump"), EInputActionValueType::Boolean);
	RunAction = MakeAction(TEXT("IA_Run"), EInputActionValueType::Boolean);
	InteractAction = MakeAction(TEXT("IA_Interact"), EInputActionValueType::Boolean);
	BackAction = MakeAction(TEXT("IA_Back"), EInputActionValueType::Boolean);
	MenuAction = MakeAction(TEXT("IA_Menu"), EInputActionValueType::Boolean);
	ZoomAction = MakeAction(TEXT("IA_Zoom"), EInputActionValueType::Axis1D);
	NumberAction = MakeAction(TEXT("IA_Number"), EInputActionValueType::Axis1D);

	UInputMappingContext* M = Mapping;
	auto Swizzle = [M]()
	{
		UInputModifierSwizzleAxis* S = NewObject<UInputModifierSwizzleAxis>(M);
		S->Order = EInputAxisSwizzle::YXZ;
		return S;
	};
	auto Negate = [M]() { return NewObject<UInputModifierNegate>(M); };
	auto Scalar = [M](float K)
	{
		UInputModifierScalar* S = NewObject<UInputModifierScalar>(M);
		S->Scalar = FVector(K, K, K);
		return S;
	};

	// WASD + arrows: W/Up = +Y (forward), S/Down = -Y, D/Right = +X, A/Left = -X.
	for (const FKey& K : {EKeys::W, EKeys::Up})
	{
		M->MapKey(MoveAction, K).Modifiers.Add(Swizzle());
	}
	for (const FKey& K : {EKeys::S, EKeys::Down})
	{
		FEnhancedActionKeyMapping& Map = M->MapKey(MoveAction, K);
		Map.Modifiers.Add(Swizzle());
		Map.Modifiers.Add(Negate());
	}
	for (const FKey& K : {EKeys::A, EKeys::Left})
	{
		M->MapKey(MoveAction, K).Modifiers.Add(Negate());
	}
	M->MapKey(MoveAction, EKeys::D);
	M->MapKey(MoveAction, EKeys::Right);
	M->MapKey(MoveAction, EKeys::Gamepad_Left2D);

	M->MapKey(LookAction, EKeys::Mouse2D);
	{
		FEnhancedActionKeyMapping& Map = M->MapKey(LookAction, EKeys::Gamepad_Right2D);
		Map.Modifiers.Add(Scalar(2.2f));
	}

	M->MapKey(JumpAction, EKeys::SpaceBar);
	M->MapKey(JumpAction, EKeys::Gamepad_FaceButton_Top);
	M->MapKey(RunAction, EKeys::LeftShift);
	M->MapKey(RunAction, EKeys::Gamepad_LeftThumbstick);
	M->MapKey(InteractAction, EKeys::E);
	M->MapKey(InteractAction, EKeys::Enter);
	M->MapKey(InteractAction, EKeys::Gamepad_FaceButton_Bottom);
	M->MapKey(BackAction, EKeys::Escape);
	M->MapKey(BackAction, EKeys::BackSpace);
	M->MapKey(BackAction, EKeys::Gamepad_FaceButton_Right);
	M->MapKey(MenuAction, EKeys::Tab);
	M->MapKey(MenuAction, EKeys::M);
	M->MapKey(MenuAction, EKeys::Gamepad_Special_Right);
	M->MapKey(ZoomAction, EKeys::MouseWheelAxis);
	const FKey Numbers[] = {EKeys::One, EKeys::Two, EKeys::Three, EKeys::Four, EKeys::Five, EKeys::Six};
	for (int32 i = 0; i < 6; ++i)
	{
		M->MapKey(NumberAction, Numbers[i]).Modifiers.Add(Scalar(float(i + 1)));
	}
}

void ALigaCharacter::PawnClientRestart()
{
	if (!Mapping) BuildInput();
	Super::PawnClientRestart();
	if (APlayerController* PC = Cast<APlayerController>(GetController()))
	{
		if (UEnhancedInputLocalPlayerSubsystem* Sub = ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()))
		{
			Sub->ClearAllMappings();
			Sub->AddMappingContext(Mapping, 0);
		}
	}
}

void ALigaCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);
	if (!Mapping) BuildInput();
	UEnhancedInputComponent* In = Cast<UEnhancedInputComponent>(PlayerInputComponent);
	if (!In)
	{
		UE_LOG(LogLigaChar, Error, TEXT("Enhanced Input is not the default input component (Config/DefaultInput.ini)"));
		return;
	}
	In->BindAction(MoveAction, ETriggerEvent::Triggered, this, &ALigaCharacter::OnMove);
	In->BindAction(LookAction, ETriggerEvent::Triggered, this, &ALigaCharacter::OnLook);
	In->BindAction(JumpAction, ETriggerEvent::Started, this, &ALigaCharacter::OnJump);
	In->BindAction(RunAction, ETriggerEvent::Started, this, &ALigaCharacter::OnRunStart);
	In->BindAction(RunAction, ETriggerEvent::Completed, this, &ALigaCharacter::OnRunStop);
	In->BindAction(InteractAction, ETriggerEvent::Started, this, &ALigaCharacter::OnInteract);
	In->BindAction(BackAction, ETriggerEvent::Started, this, &ALigaCharacter::OnBack);
	In->BindAction(MenuAction, ETriggerEvent::Started, this, &ALigaCharacter::OnMenu);
	In->BindAction(ZoomAction, ETriggerEvent::Triggered, this, &ALigaCharacter::OnZoom);
	In->BindAction(NumberAction, ETriggerEvent::Started, this, &ALigaCharacter::OnNumber);
}

void ALigaCharacter::OnMove(const FInputActionValue& V)
{
	ALigaPlayerController* PC = LigaPC();
	if (!PC || !PC->IsExploring()) return;
	const FVector2D In = V.Get<FVector2D>();
	const FRotator Yaw(0.f, PC->GetControlRotation().Yaw, 0.f);
	AddMovementInput(FRotationMatrix(Yaw).GetUnitAxis(EAxis::X), In.Y);
	AddMovementInput(FRotationMatrix(Yaw).GetUnitAxis(EAxis::Y), In.X);
}

void ALigaCharacter::OnLook(const FInputActionValue& V)
{
	ALigaPlayerController* PC = LigaPC();
	if (!PC || !PC->IsExploring()) return;
	const FVector2D In = V.Get<FVector2D>();
	AddControllerYawInput(In.X);
	AddControllerPitchInput(-In.Y);
}

void ALigaCharacter::OnJump()
{
	if (ALigaPlayerController* PC = LigaPC())
	{
		if (PC->IsExploring()) Jump();
	}
}

void ALigaCharacter::OnRunStart() { GetCharacterMovement()->MaxWalkSpeed = 720.f; }
void ALigaCharacter::OnRunStop() { GetCharacterMovement()->MaxWalkSpeed = 420.f; }

void ALigaCharacter::OnInteract()
{
	ALigaPlayerController* PC = LigaPC();
	if (!PC) return;
	if (!PC->IsExploring())
	{
		PC->OnConfirm();
		return;
	}
	if (ILigaInteractable* I = Cast<ILigaInteractable>(Focus.Get()))
	{
		// Turn towards what we talk to.
		const FVector To = (Focus->GetActorLocation() - GetActorLocation()).GetSafeNormal2D();
		if (!To.IsNearlyZero()) SetActorRotation(To.Rotation());
		I->Interact(PC);
	}
}

void ALigaCharacter::OnBack()
{
	if (ALigaPlayerController* PC = LigaPC()) PC->OnBack();
}

void ALigaCharacter::OnMenu()
{
	if (ALigaPlayerController* PC = LigaPC()) PC->ToggleMenu();
}

void ALigaCharacter::OnZoom(const FInputActionValue& V)
{
	ZoomGoal = FMath::Clamp(ZoomGoal - V.Get<float>() * 60.f, 220.f, 900.f);
}

void ALigaCharacter::OnNumber(const FInputActionValue& V)
{
	if (ALigaPlayerController* PC = LigaPC()) PC->OnNumberKey(FMath::RoundToInt(V.Get<float>()));
}

void ALigaCharacter::Tick(float Dt)
{
	Super::Tick(Dt);
	CameraBoom->TargetArmLength = FMath::FInterpTo(CameraBoom->TargetArmLength, ZoomGoal, Dt, 8.f);
	FocusTimer -= Dt;
	if (FocusTimer <= 0.f)
	{
		FocusTimer = 0.12f;
		UpdateFocus();
	}
	UpdateEncounters(Dt);
}

void ALigaCharacter::UpdateFocus()
{
	AActor* Best = nullptr;
	float BestScore = 0.f;
	const FVector Me = GetActorLocation();
	const FVector Fwd = GetActorForwardVector();
	for (TActorIterator<AActor> It(GetWorld()); It; ++It)
	{
		AActor* A = *It;
		if (A == this || !A->Implements<ULigaInteractable>()) continue;
		const FVector D = A->GetActorLocation() - Me;
		const float Dist = D.Size2D();
		if (Dist > 260.f || FMath::Abs(D.Z) > 250.f) continue;
		const float Facing = FVector::DotProduct(D.GetSafeNormal2D(), Fwd);
		if (Facing < -0.2f && Dist > 120.f) continue;
		const float Score = (1.f - Dist / 260.f) + Facing * 0.5f;
		if (!Best || Score > BestScore)
		{
			Best = A;
			BestScore = Score;
		}
	}
	Focus = Best;
}

void ALigaCharacter::UpdateEncounters(float Dt)
{
	const FVector Pos = GetActorLocation();
	const float Moved = FVector::Dist2D(Pos, LastPos);
	LastPos = Pos;
	ALigaPlayerController* PC = LigaPC();
	if (!PC || !PC->IsExploring() || Moved <= 0.f || Moved > 200.f) return;
	TArray<AActor*> Zones;
	GetOverlappingActors(Zones, ALigaEncounterZone::StaticClass());
	if (Zones.Num() == 0)
	{
		GrassWalk = 0.f;
		return;
	}
	GrassWalk += Moved;
	if (GrassWalk < 160.f) return;
	GrassWalk = 0.f;
	if (FMath::FRand() < 0.13f)
	{
		const ALigaEncounterZone* Z = Cast<ALigaEncounterZone>(Zones[0]);
		PC->TryWildEncounter(Z ? Z->Route : FString(TEXT("route1")));
	}
}
