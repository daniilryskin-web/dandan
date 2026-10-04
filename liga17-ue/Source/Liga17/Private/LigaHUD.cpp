#include "LigaHUD.h"

#include "Brushes/SlateRoundedBoxBrush.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/Font.h"
#include "Engine/GameViewportClient.h"
#include "Engine/Texture2D.h"
#include "Framework/Application/SlateApplication.h"
#include "LigaBattleStage.h"
#include "LigaData.h"
#include "LigaGameInstance.h"
#include "LigaPlayerController.h"
#include "Styling/CoreStyle.h"
#include "Styling/SlateTypes.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SSpacer.h"
#include "Widgets/Notifications/SProgressBar.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SNullWidget.h"
#include "Widgets/SOverlay.h"
#include "Widgets/SWeakWidget.h"
#include "Widgets/Text/STextBlock.h"

namespace LigaUI
{
	FLinearColor Hex(const TCHAR* H) { return FLinearColor(FColor::FromHex(H)); }
	const FLinearColor Ink = Hex(TEXT("15192B"));
	const FLinearColor Muted = Hex(TEXT("5A6380"));
	const FLinearColor Accent = Hex(TEXT("F2633A"));
	const FLinearColor Yellow = Hex(TEXT("F6FF6A"));
	const FLinearColor Panel = FLinearColor(0.035f, 0.045f, 0.09f, 0.88f);
	const FLinearColor Plate = FLinearColor(1.f, 1.f, 1.f, 0.95f);

	FSlateFontInfo Font(int32 Size, bool bBold = true) { return FCoreStyle::GetDefaultFontStyle(bBold ? "Bold" : "Regular", Size); }

	FLinearColor HpColor(float R)
	{
		if (R > 0.5f) return Hex(TEXT("4ADE80"));
		if (R > 0.2f) return Hex(TEXT("FACC15"));
		return Hex(TEXT("F43F5E"));
	}
}

using namespace LigaUI;

class SLigaHUDWidget : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SLigaHUDWidget) {}
		SLATE_ARGUMENT(TWeakObjectPtr<ALigaPlayerController>, Owner)
	SLATE_END_ARGS()

	void Construct(const FArguments& Args);
	/** Rebuilds the dynamic panels. Called from the HUD actor's tick, i.e. before Slate lays out and paints the frame:
	 *  widgets swapped in during Slate's own Tick (which runs inside paint) get no layout that frame and draw without backgrounds. */
	void Refresh();

private:
	TWeakObjectPtr<ALigaPlayerController> PC;
	int32 LastSerial = -1;
	FString TeamSignature;

	// Brushes and styles must outlive the widgets that point to them.
	FSlateRoundedBoxBrush PlateBrush{Plate, 16.f};
	FSlateRoundedBoxBrush PanelBrush{Panel, 18.f};
	FSlateRoundedBoxBrush PillBrush{Accent, 12.f};
	FSlateRoundedBoxBrush DarkPill{Ink, 6.f};
	FSlateRoundedBoxBrush BarBack{Hex(TEXT("2A2F45")), 6.f};
	FSlateRoundedBoxBrush BarFill{FLinearColor::White, 6.f};
	FSlateRoundedBoxBrush ExpFill{Hex(TEXT("2FA8FF")), 3.f};
	FSlateRoundedBoxBrush CardBrush{FLinearColor(1.f, 1.f, 1.f, 0.97f), 20.f};
	FSlateBrush NoBrush;
	FProgressBarStyle HpStyle;
	FProgressBarStyle ExpStyle;
	FButtonStyle DarkButton;
	FButtonStyle LightButton;
	TMap<uint32, TSharedPtr<FButtonStyle>> ColorButtons;
	TArray<TSharedPtr<FSlateRoundedBoxBrush>> OwnedBrushes;
	TMap<FString, TSharedPtr<FSlateBrush>> MonBrushes;

	TSharedPtr<SBox> TeamBox;
	TSharedPtr<SBox> ChoiceBox;
	TSharedPtr<SBox> CommandBox;
	TSharedPtr<SBox> MenuBox;
	TSharedPtr<SWidget> FirstFocus;

	ULigaGameInstance* GI() const { return PC.IsValid() ? ULigaGameInstance::Get(PC.Get()) : nullptr; }
	ALigaBattleStage* Stage() const { return PC.IsValid() ? PC->Stage.Get() : nullptr; }
	bool InMode(ELigaMode M) const { return PC.IsValid() && PC->Mode == M; }

	const FButtonStyle* ColorButton(const FLinearColor& C);
	const FSlateBrush* MonBrush(int32 Species, bool bShiny);
	TSharedRef<SWidget> Button(const FString& Label, const FString& Detail, const FButtonStyle* Style, const FLinearColor& TextColor,
		TFunction<void()> OnClick, bool bEnabled = true, float Width = 300.f);
	TSharedRef<SWidget> MonImage(int32 Species, bool bShiny, float Size);
	TSharedRef<SWidget> TypePill(EPokeType T);

	TSharedRef<SWidget> BuildExplore();
	TSharedRef<SWidget> BuildDialogue();
	TSharedRef<SWidget> BuildBattle();
	TSharedRef<SWidget> BuildPlate(int32 Side);
	TSharedRef<SWidget> BuildTeamStrip();
	TSharedRef<SWidget> BuildChoice();
	TSharedRef<SWidget> BuildCommands();
	TSharedRef<SWidget> BuildMenu();
	const FLigaPokemon* ShownMon(int32 Side) const;
};

void SLigaHUDWidget::Construct(const FArguments& Args)
{
	PC = Args._Owner;
	NoBrush.DrawAs = ESlateBrushDrawType::NoDrawType;
	HpStyle = FProgressBarStyle().SetBackgroundImage(BarBack).SetFillImage(BarFill).SetMarqueeImage(BarFill);
	ExpStyle = FProgressBarStyle().SetBackgroundImage(BarBack).SetFillImage(ExpFill).SetMarqueeImage(ExpFill);
	auto MakeStyle = [this](const FLinearColor& Normal, const FLinearColor& Hover, const FLinearColor& Press)
	{
		TSharedPtr<FSlateRoundedBoxBrush> N = MakeShared<FSlateRoundedBoxBrush>(Normal, 22.f);
		TSharedPtr<FSlateRoundedBoxBrush> H = MakeShared<FSlateRoundedBoxBrush>(Hover, 22.f);
		TSharedPtr<FSlateRoundedBoxBrush> P = MakeShared<FSlateRoundedBoxBrush>(Press, 22.f);
		OwnedBrushes.Append({N, H, P});
		return FButtonStyle().SetNormal(*N).SetHovered(*H).SetPressed(*P).SetDisabled(*N)
			.SetNormalPadding(FMargin(0)).SetPressedPadding(FMargin(0, 2, 0, 0));
	};
	DarkButton = MakeStyle(Panel, Hex(TEXT("2B3358")), Hex(TEXT("1B2140")));
	LightButton = MakeStyle(FLinearColor(1, 1, 1, 0.95f), Yellow, Hex(TEXT("E4EC50")));

	ChildSlot
	[
		SNew(SOverlay)
		+ SOverlay::Slot()[BuildExplore()]
		+ SOverlay::Slot()[BuildBattle()]
		+ SOverlay::Slot()[BuildDialogue()]
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)[SAssignNew(ChoiceBox, SBox)]
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)[SAssignNew(MenuBox, SBox)]
		// toast
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Top).Padding(0, 90, 0, 0)
		[
			SNew(SBorder)
			.Visibility_Lambda([this] { return PC.IsValid() && PC->ToastTime > 0.f ? EVisibility::HitTestInvisible : EVisibility::Collapsed; })
			.BorderImage(&PanelBrush)
			.Padding(FMargin(22, 10))
			[
				SNew(STextBlock).Font(Font(16)).ColorAndOpacity(FLinearColor::White)
				.Text_Lambda([this] { return FText::FromString(PC.IsValid() ? PC->Toast : FString()); })
			]
		]
	];
}

const FButtonStyle* SLigaHUDWidget::ColorButton(const FLinearColor& C)
{
	const uint32 Key = C.ToFColor(true).ToPackedARGB();
	if (TSharedPtr<FButtonStyle>* Found = ColorButtons.Find(Key)) return Found->Get();
	const FLinearColor Dark = FLinearColor::LerpUsingHSV(C, Hex(TEXT("0E1122")), 0.35f);
	TSharedPtr<FSlateRoundedBoxBrush> N = MakeShared<FSlateRoundedBoxBrush>(Dark, 22.f);
	TSharedPtr<FSlateRoundedBoxBrush> H = MakeShared<FSlateRoundedBoxBrush>(C, 22.f, Yellow, 3.f);
	TSharedPtr<FSlateRoundedBoxBrush> P = MakeShared<FSlateRoundedBoxBrush>(C, 22.f);
	OwnedBrushes.Append({N, H, P});
	TSharedPtr<FButtonStyle> S = MakeShared<FButtonStyle>(FButtonStyle().SetNormal(*N).SetHovered(*H).SetPressed(*P).SetDisabled(*N)
		.SetNormalPadding(FMargin(0)).SetPressedPadding(FMargin(0, 2, 0, 0)));
	ColorButtons.Add(Key, S);
	return S.Get();
}

const FSlateBrush* SLigaHUDWidget::MonBrush(int32 Species, bool bShiny)
{
	const FString Key = FString::Printf(TEXT("%d_%d"), Species, bShiny ? 1 : 0);
	if (TSharedPtr<FSlateBrush>* B = MonBrushes.Find(Key)) return B->Get();
	ULigaGameInstance* G = GI();
	if (!G) return &NoBrush;
	if (UTexture2D* Tex = G->GetCachedTexture(Species, bShiny))
	{
		TSharedPtr<FSlateBrush> B = MakeShared<FSlateBrush>();
		B->SetResourceObject(Tex);
		B->ImageSize = FVector2D(256, 256);
		B->DrawAs = ESlateBrushDrawType::Image;
		MonBrushes.Add(Key, B);
		return B.Get();
	}
	G->RequestPokemonTexture(Species, bShiny, FLigaTextureReady());
	return &NoBrush;
}

TSharedRef<SWidget> SLigaHUDWidget::MonImage(int32 Species, bool bShiny, float Size)
{
	return SNew(SBox).WidthOverride(Size).HeightOverride(Size)
	[
		SNew(SImage).Image_Lambda([this, Species, bShiny] { return MonBrush(Species, bShiny); })
	];
}

TSharedRef<SWidget> SLigaHUDWidget::TypePill(EPokeType T)
{
	TSharedPtr<FSlateRoundedBoxBrush> B = MakeShared<FSlateRoundedBoxBrush>(LigaTypes::Color(T), 10.f);
	OwnedBrushes.Add(B);
	return SNew(SBorder).BorderImage(B.Get()).Padding(FMargin(9, 2))
	[
		SNew(STextBlock).Text(FText::FromString(LigaTypes::Name(T))).Font(Font(10)).ColorAndOpacity(FLinearColor::White)
	];
}

TSharedRef<SWidget> SLigaHUDWidget::Button(const FString& Label, const FString& Detail, const FButtonStyle* Style, const FLinearColor& TextColor,
	TFunction<void()> OnClick, bool bEnabled, float Width)
{
	TSharedRef<SVerticalBox> Text = SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).Text(FText::FromString(Label)).Font(Font(16)).ColorAndOpacity(TextColor)];
	if (!Detail.IsEmpty())
	{
		Text->AddSlot().AutoHeight()[SNew(STextBlock).Text(FText::FromString(Detail)).Font(Font(11, false)).ColorAndOpacity(TextColor.CopyWithNewOpacity(0.85f))];
	}
	TSharedRef<SButton> Btn = SNew(SButton)
		.ButtonStyle(Style)
		.IsEnabled(bEnabled)
		.ContentPadding(FMargin(20, 10))
		.OnClicked_Lambda([OnClick] { if (OnClick) OnClick(); return FReply::Handled(); })
		[Text];
	if (!FirstFocus.IsValid() && bEnabled) FirstFocus = Btn;
	return SNew(SBox).WidthOverride(Width).Padding(FMargin(0, 4))[Btn];
}

// ——— overworld ———

TSharedRef<SWidget> SLigaHUDWidget::BuildExplore()
{
	return SNew(SOverlay)
		.Visibility_Lambda([this] { return InMode(ELigaMode::Explore) || InMode(ELigaMode::Dialogue) || InMode(ELigaMode::Menu) ? EVisibility::SelfHitTestInvisible : EVisibility::Collapsed; })
		// location banner
		+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Top).Padding(28, 24)
		[
			SNew(SBorder).BorderImage(&PlateBrush).Padding(FMargin(22, 10, 30, 12))
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).Text(FText::FromString(TEXT("КАНТО"))).Font(Font(10)).ColorAndOpacity(Accent)]
				+ SVerticalBox::Slot().AutoHeight()
				[
					SNew(STextBlock).Font(Font(22)).ColorAndOpacity(Ink)
					.Text_Lambda([this] { return FText::FromString(PC.IsValid() ? PC->CurrentPlaceName() : FString()); })
				]
			]
		]
		// controls help
		+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Top).Padding(28, 24)
		[
			SNew(SBorder).BorderImage(&PanelBrush).Padding(FMargin(16, 10))
			[
				SNew(STextBlock).Font(Font(11, false)).ColorAndOpacity(FLinearColor(1, 1, 1, 0.85f))
				.Text(FText::FromString(TEXT("WASD — ходить   Shift — бег   Пробел — прыжок\nE — действие   Tab — меню   Колесо — камера")))
			]
		]
		// team
		+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Bottom).Padding(28, 28)
		[
			SNew(SBorder).BorderImage(&PanelBrush).Padding(FMargin(10, 8, 16, 8))
			.Visibility_Lambda([this] { const ULigaGameInstance* G = GI(); return G && G->Data.Team.Num() > 0 ? EVisibility::SelfHitTestInvisible : EVisibility::Collapsed; })
			[SAssignNew(TeamBox, SBox)]
		]
		// interaction prompt
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Bottom).Padding(0, 0, 0, 60)
		[
			SNew(SBorder)
			.Visibility_Lambda([this] { return PC.IsValid() && !PC->CurrentPrompt().IsEmpty() ? EVisibility::HitTestInvisible : EVisibility::Collapsed; })
			.BorderImage(&PlateBrush).Padding(FMargin(10, 8, 22, 8))
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 12, 0)
				[
					SNew(SBorder).BorderImage(&DarkPill).Padding(FMargin(10, 3))
					[SNew(STextBlock).Text(FText::FromString(TEXT("E"))).Font(Font(14)).ColorAndOpacity(Yellow)]
				]
				+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
				[
					SNew(STextBlock).Font(Font(16)).ColorAndOpacity(Ink)
					.Text_Lambda([this] { return FText::FromString(PC.IsValid() ? PC->CurrentPrompt() : FString()); })
				]
			]
		];
}

TSharedRef<SWidget> SLigaHUDWidget::BuildTeamStrip()
{
	ULigaGameInstance* G = GI();
	TSharedRef<SVerticalBox> Box = SNew(SVerticalBox);
	if (!G || G->Data.Team.Num() == 0) return Box;
	for (const FLigaPokemon& P : G->Data.Team)
	{
		const float R = FMath::Clamp(float(P.HP) / float(FMath::Max(1, LigaRules::MaxHp(P))), 0.f, 1.f);
		Box->AddSlot().AutoHeight().Padding(0, 2)
		[
			SNew(SBox).WidthOverride(262)
			[
				SNew(SBorder).BorderImage(&NoBrush).Padding(0)
				.ColorAndOpacity(P.IsFainted() ? FLinearColor(1, 1, 1, 0.5f) : FLinearColor::White)
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[MonImage(P.Species, P.bShiny, 46)]
					+ SHorizontalBox::Slot().FillWidth(1).VAlign(VAlign_Center).Padding(8, 0, 0, 0)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()
						[
							SNew(STextBlock).Font(Font(13)).ColorAndOpacity(FLinearColor::White)
							.Text(FText::FromString(FString::Printf(TEXT("%s  ур. %d"), *LigaRules::DisplayName(P), P.Level)))
						]
						+ SVerticalBox::Slot().AutoHeight().Padding(0, 4, 0, 0)
						[
							SNew(SBox).HeightOverride(7)
							[SNew(SProgressBar).Style(&HpStyle).Percent(R).FillColorAndOpacity(HpColor(R))]
						]
					]
				]
			]
		];
	}
	return Box;
}

TSharedRef<SWidget> SLigaHUDWidget::BuildDialogue()
{
	return SNew(SBox)
		.Visibility_Lambda([this] { return InMode(ELigaMode::Dialogue) ? EVisibility::Visible : EVisibility::Collapsed; })
		.HAlign(HAlign_Center).VAlign(VAlign_Bottom).Padding(FMargin(0, 0, 0, 48))
		[
			SNew(SBox).WidthOverride(980)
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Left).Padding(28, 0, 0, -6)
				[
					SNew(SBorder).BorderImage(&PillBrush).Padding(FMargin(18, 6))
					.Visibility_Lambda([this] { return PC.IsValid() && !PC->Speaker.IsEmpty() ? EVisibility::Visible : EVisibility::Collapsed; })
					[
						SNew(STextBlock).Font(Font(15)).ColorAndOpacity(FLinearColor::White)
						.Text_Lambda([this] { return FText::FromString(PC.IsValid() ? PC->Speaker : FString()); })
					]
				]
				+ SVerticalBox::Slot().AutoHeight()
				[
					SNew(SButton).ButtonStyle(&DarkButton).ContentPadding(FMargin(34, 26, 34, 20))
					.OnClicked_Lambda([this] { if (PC.IsValid()) PC->AdvanceDialogue(); return FReply::Handled(); })
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()
						[
							SNew(STextBlock).Font(Font(20, false)).ColorAndOpacity(FLinearColor::White).AutoWrapText(true)
							.Text_Lambda([this]
							{
								if (!PC.IsValid() || !PC->Lines.IsValidIndex(PC->LineIndex)) return FText::GetEmpty();
								return FText::FromString(PC->Lines[PC->LineIndex]);
							})
						]
						+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right)
						[SNew(STextBlock).Text(FText::FromString(TEXT("▼  E"))).Font(Font(12)).ColorAndOpacity(Yellow)]
					]
				]
			]
		];
}

TSharedRef<SWidget> SLigaHUDWidget::BuildChoice()
{
	FirstFocus.Reset();
	if (!PC.IsValid() || PC->Mode != ELigaMode::Choice) return SNullWidget::NullWidget;
	TSharedRef<SVerticalBox> Col = SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 14)
		[SNew(STextBlock).Text(FText::FromString(PC->ChoiceTitle)).Font(Font(20)).ColorAndOpacity(Ink).AutoWrapText(true)];
	TWeakObjectPtr<ALigaPlayerController> W = PC;
	if (PC->bChoicePictures)
	{
		TSharedRef<SHorizontalBox> Row = SNew(SHorizontalBox);
		for (int32 i = 0; i < PC->Choices.Num(); ++i)
		{
			const FLigaChoice& C = PC->Choices[i];
			TSharedRef<SButton> Btn = SNew(SButton).ButtonStyle(&LightButton).ContentPadding(FMargin(18, 14))
				.OnClicked_Lambda([W, i] { if (W.IsValid()) W->PickChoice(i); return FReply::Handled(); })
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)[MonImage(C.Species, false, 190)]
					+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
					[SNew(STextBlock).Text(FText::FromString(FString::Printf(TEXT("%d. %s"), i + 1, *C.Label))).Font(Font(20)).ColorAndOpacity(Ink)]
					+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(0, 4, 0, 0)
					[SNew(STextBlock).Text(FText::FromString(C.Detail)).Font(Font(12, false)).ColorAndOpacity(C.Color)]
				];
			if (!FirstFocus.IsValid()) FirstFocus = Btn;
			Row->AddSlot().AutoWidth().Padding(8, 0)[SNew(SBox).WidthOverride(250)[Btn]];
		}
		Col->AddSlot().AutoHeight()[Row];
	}
	else
	{
		for (int32 i = 0; i < PC->Choices.Num(); ++i)
		{
			const FLigaChoice& C = PC->Choices[i];
			Col->AddSlot().AutoHeight()
			[
				Button(FString::Printf(TEXT("%d. %s"), i + 1, *C.Label), C.Detail, ColorButton(C.Color), FLinearColor::White,
					[W, i] { if (W.IsValid()) W->PickChoice(i); }, C.bEnabled, 520.f)
			];
		}
	}
	return SNew(SBorder).BorderImage(&CardBrush).Padding(FMargin(30, 24))[Col];
}

// ——— battle ———

const FLigaPokemon* SLigaHUDWidget::ShownMon(int32 Side) const
{
	ULigaGameInstance* G = GI();
	ALigaBattleStage* S = Stage();
	if (!G || !G->Battle || !S) return nullptr;
	const int32 Uid = S->ShownUid[Side];
	if (Side == 0) return G->Data.FindByUid(Uid);
	for (const FLigaPokemon& P : G->Battle->EnemyTeam)
	{
		if (P.Uid == Uid) return &P;
	}
	return nullptr;
}

TSharedRef<SWidget> SLigaHUDWidget::BuildPlate(int32 Side)
{
	auto Pct = [this, Side]
	{
		const ALigaBattleStage* S = Stage();
		return S ? FMath::Clamp(float(S->ShownHp[Side]) / float(FMath::Max(1, S->MaxHp[Side])), 0.f, 1.f) : 0.f;
	};
	return SNew(SBox).WidthOverride(400)
		.Visibility_Lambda([this, Side] { return ShownMon(Side) && !(Side == 0 && Stage() && Stage()->bIntro) ? EVisibility::HitTestInvisible : EVisibility::Hidden; })
		[
			SNew(SBorder).BorderImage(&PlateBrush).Padding(FMargin(22, 12, 22, 14))
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().FillWidth(1)
					[
						SNew(STextBlock).Font(Font(20)).ColorAndOpacity(Ink)
						.Text_Lambda([this, Side]
						{
							const FLigaPokemon* P = ShownMon(Side);
							if (!P) return FText::GetEmpty();
							const TCHAR* G = P->Gender == 1 ? TEXT(" ♂") : P->Gender == 2 ? TEXT(" ♀") : TEXT("");
							return FText::FromString(FString::Printf(TEXT("%s%s%s"), P->bShiny ? TEXT("✦ ") : TEXT(""), *LigaRules::DisplayName(*P), G));
						})
					]
					+ SHorizontalBox::Slot().AutoWidth()
					[
						SNew(STextBlock).Font(Font(18)).ColorAndOpacity(Ink)
						.Text_Lambda([this, Side] { const FLigaPokemon* P = ShownMon(Side); return FText::FromString(P ? FString::Printf(TEXT("Ур. %d"), P->Level) : FString()); })
					]
				]
				+ SVerticalBox::Slot().AutoHeight().Padding(0, 8, 0, 0)
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 8, 0)
					[SNew(SBorder).BorderImage(&DarkPill).Padding(FMargin(6, 1))[SNew(STextBlock).Text(FText::FromString(TEXT("HP"))).Font(Font(10)).ColorAndOpacity(Hex(TEXT("FFD84A")))]]
					+ SHorizontalBox::Slot().FillWidth(1).VAlign(VAlign_Center)
					[
						SNew(SBox).HeightOverride(12)
						[
							SNew(SProgressBar).Style(&HpStyle)
							.Percent_Lambda([Pct] { return TOptional<float>(Pct()); })
							.FillColorAndOpacity_Lambda([Pct] { return FSlateColor(HpColor(Pct())); })
						]
					]
				]
				+ SVerticalBox::Slot().AutoHeight().Padding(0, 6, 0, 0)
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().FillWidth(1)
					[
						SNew(STextBlock).Font(Font(12)).ColorAndOpacity_Lambda([this, Side]
						{
							const ALigaBattleStage* S = Stage();
							return FSlateColor(S && S->ShownStatus[Side] != EStatus::None ? LigaTypes::StatusColor(S->ShownStatus[Side]) : Muted);
						})
						.Text_Lambda([this, Side]
						{
							const FLigaPokemon* P = ShownMon(Side);
							const ALigaBattleStage* S = Stage();
							if (!P || !S) return FText::GetEmpty();
							FString Types;
							for (EPokeType T : LigaRules::TypesOf(*P)) Types += (Types.IsEmpty() ? TEXT("") : TEXT(" / ")) + LigaTypes::Name(T);
							if (S->ShownStatus[Side] != EStatus::None) Types = LigaTypes::StatusShort(S->ShownStatus[Side]) + TEXT("   ") + Types;
							return FText::FromString(Types);
						})
					]
					+ SHorizontalBox::Slot().AutoWidth()
					[
						SNew(STextBlock).Font(Font(16)).ColorAndOpacity(Ink)
						.Visibility(Side == 0 ? EVisibility::Visible : EVisibility::Collapsed)
						.Text_Lambda([this, Side]
						{
							const ALigaBattleStage* S = Stage();
							return FText::FromString(S ? FString::Printf(TEXT("%d / %d"), FMath::Max(0, S->ShownHp[Side]), S->MaxHp[Side]) : FString());
						})
					]
				]
				+ SVerticalBox::Slot().AutoHeight().Padding(0, 6, 0, 0)
				[
					SNew(SBox).HeightOverride(5).Visibility(Side == 0 ? EVisibility::Visible : EVisibility::Collapsed)
					[
						SNew(SProgressBar).Style(&ExpStyle)
						.Percent_Lambda([this] { const FLigaPokemon* P = ShownMon(0); return TOptional<float>(P ? LigaRules::ExpRatio(*P) : 0.f); })
					]
				]
			]
		];
}

TSharedRef<SWidget> SLigaHUDWidget::BuildBattle()
{
	return SNew(SOverlay)
		.Visibility_Lambda([this] { return InMode(ELigaMode::Battle) || (InMode(ELigaMode::Choice) && Stage()) || (InMode(ELigaMode::Dialogue) && Stage()) ? EVisibility::SelfHitTestInvisible : EVisibility::Collapsed; })
		+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Top).Padding(36, 30)[BuildPlate(1)]
		+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Bottom).Padding(36, 34)[BuildPlate(0)]
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Bottom).Padding(0, 0, 0, 36)
		[
			SNew(SBox).WidthOverride(640)
			.Visibility_Lambda([this] { return InMode(ELigaMode::Battle) ? EVisibility::Visible : EVisibility::Collapsed; })
			[
				SNew(SButton).ButtonStyle(&DarkButton).ContentPadding(FMargin(26, 18))
				.OnClicked_Lambda([this] { if (PC.IsValid()) PC->OnConfirm(); return FReply::Handled(); })
				[
					SNew(STextBlock).Font(Font(17, false)).ColorAndOpacity(FLinearColor::White).AutoWrapText(true)
					.Text_Lambda([this]
					{
						if (!PC.IsValid()) return FText::GetEmpty();
						ULigaGameInstance* G = GI();
						if (PC->BattleMenu == ELigaBattleMenu::Main && G && G->Battle)
						{
							return FText::FromString(FString::Printf(TEXT("Что сделает %s?"), *LigaRules::DisplayName(G->Battle->PlayerMon())));
						}
						const ALigaBattleStage* S = Stage();
						return FText::FromString(S ? S->Message : FString());
					})
				]
			]
		]
		+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Bottom).Padding(36, 30)
		[
			SAssignNew(CommandBox, SBox)
			.Visibility_Lambda([this] { return InMode(ELigaMode::Battle) ? EVisibility::Visible : EVisibility::Collapsed; })
		];
}

TSharedRef<SWidget> SLigaHUDWidget::BuildCommands()
{
	FirstFocus.Reset();
	ULigaGameInstance* G = GI();
	if (!PC.IsValid() || !G || !G->Battle) return SNullWidget::NullWidget;
	FLigaBattle& B = *G->Battle;
	TWeakObjectPtr<ALigaPlayerController> W = PC;
	TSharedRef<SVerticalBox> Col = SNew(SVerticalBox);
	const FLinearColor White = FLinearColor::White;
	auto Back = [this, &Col, W]()
	{
		Col->AddSlot().AutoHeight().HAlign(HAlign_Right)
		[Button(TEXT("← Назад  (Esc)"), FString(), &DarkButton, FLinearColor::White, [W] { if (W.IsValid()) W->SetBattleMenu(ELigaBattleMenu::Main); }, true, 220.f)];
	};
	switch (PC->BattleMenu)
	{
	case ELigaBattleMenu::Main:
		Col->AddSlot().AutoHeight().HAlign(HAlign_Right)[Button(TEXT("1  Бой"), FString(), ColorButton(Accent), White, [W] { if (W.IsValid()) W->SetBattleMenu(ELigaBattleMenu::Fight); }, true, 330.f)];
		Col->AddSlot().AutoHeight().HAlign(HAlign_Right)[Button(TEXT("2  Покемоны"), FString(), ColorButton(Hex(TEXT("22A35A"))), White, [W] { if (W.IsValid()) W->SetBattleMenu(ELigaBattleMenu::Team); }, true, 290.f)];
		Col->AddSlot().AutoHeight().HAlign(HAlign_Right)[Button(TEXT("3  Сумка"), FString(), ColorButton(Hex(TEXT("F29A1A"))), White, [W] { if (W.IsValid()) W->SetBattleMenu(ELigaBattleMenu::Bag); }, true, 290.f)];
		Col->AddSlot().AutoHeight().HAlign(HAlign_Right)[Button(TEXT("4  Бежать"), FString(), ColorButton(Hex(TEXT("2F7BFF"))), White, [W] { if (W.IsValid()) W->BattleRun(); }, B.bWild, 290.f)];
		break;
	case ELigaBattleMenu::Fight:
	{
		const FLigaPokemon& P = B.PlayerMon();
		const TArray<EPokeType> EnemyTypes = LigaRules::TypesOf(B.EnemyMon());
		const bool bKnown = G->Data.Dex.Contains(B.EnemyMon().Species);
		const bool bAllEmpty = !P.Moves.ContainsByPredicate([](const FLigaMoveSlot& M) { return M.PP > 0; });
		for (int32 i = 0; i < P.Moves.Num(); ++i)
		{
			const FLigaMoveSlot& Slot = P.Moves[i];
			const FLigaMove* M = FLigaDatabase::Get().Move(Slot.Id);
			if (!M) continue;
			const TCHAR* Cat = M->Category == EMoveCategory::Physical ? TEXT("Физ.") : M->Category == EMoveCategory::Special ? TEXT("Спец.") : TEXT("Статус");
			FString Detail = FString::Printf(TEXT("%s · %s%s · PP %d/%d"), *LigaTypes::Name(M->Type), Cat,
				M->Power > 0 ? *FString::Printf(TEXT(" · %d"), M->Power) : TEXT(""), Slot.PP, Slot.MaxPP);
			if (bKnown && M->Category != EMoveCategory::Status)
			{
				const FString Eff = LigaTypes::EffectivenessLabel(LigaTypes::Effectiveness(M->Type, EnemyTypes));
				if (!Eff.IsEmpty()) Detail += TEXT(" · ") + Eff;
			}
			Col->AddSlot().AutoHeight().HAlign(HAlign_Right)
			[
				Button(FString::Printf(TEXT("%d  %s"), i + 1, *M->Name), Detail, ColorButton(LigaTypes::Color(M->Type)), White,
					[W, i] { if (W.IsValid()) W->BattleMove(i); }, Slot.PP > 0 || bAllEmpty, 440.f)
			];
		}
		Back();
		break;
	}
	case ELigaBattleMenu::Bag:
	{
		int32 Shown = 0;
		for (const FLigaItem& It : FLigaDatabase::Get().Items())
		{
			const int32 N = G->Data.ItemCount(It.Id);
			if (N <= 0) continue;
			if (It.Kind == TEXT("ball") && !B.bWild) continue;
			if (It.Kind == TEXT("revive")) continue;
			const FString Id = It.Id;
			Col->AddSlot().AutoHeight().HAlign(HAlign_Right)
			[
				Button(FString::Printf(TEXT("%s  ×%d"), *It.Name, N), It.Desc, &LightButton, Ink, [W, Id] { if (W.IsValid()) W->BattleItem(Id); }, true, 420.f)
			];
			++Shown;
		}
		if (Shown == 0)
		{
			Col->AddSlot().AutoHeight().Padding(0, 0, 0, 8)
			[
				SNew(SBorder).BorderImage(&PanelBrush).Padding(FMargin(18, 12))
				[SNew(STextBlock).Text(FText::FromString(TEXT("Подходящих предметов нет."))).Font(Font(14, false)).ColorAndOpacity(FLinearColor::White)]
			];
		}
		Back();
		break;
	}
	case ELigaBattleMenu::Team:
	case ELigaBattleMenu::ForceSwitch:
	{
		const bool bForce = PC->BattleMenu == ELigaBattleMenu::ForceSwitch;
		Col->AddSlot().AutoHeight().HAlign(HAlign_Right).Padding(0, 0, 0, 6)
		[
			SNew(SBorder).BorderImage(&PanelBrush).Padding(FMargin(16, 8))
			[SNew(STextBlock).Text(FText::FromString(bForce ? TEXT("Кого выпустить?") : TEXT("Сменить покемона"))).Font(Font(14)).ColorAndOpacity(FLinearColor::White)]
		];
		for (int32 i = 0; i < G->Data.Team.Num(); ++i)
		{
			const FLigaPokemon& P = G->Data.Team[i];
			const bool bOk = !P.IsFainted() && i != B.PlayerActive;
			Col->AddSlot().AutoHeight().HAlign(HAlign_Right)
			[
				Button(FString::Printf(TEXT("%s  ур. %d"), *LigaRules::DisplayName(P), P.Level),
					FString::Printf(TEXT("HP %d/%d%s"), P.HP, LigaRules::MaxHp(P), P.GetStatus() != EStatus::None ? *(TEXT("  ") + LigaTypes::StatusShort(P.GetStatus())) : TEXT("")),
					&LightButton, Ink, [W, i] { if (W.IsValid()) W->BattleSwitch(i); }, bOk, 380.f)
			];
		}
		if (!bForce) Back();
		break;
	}
	case ELigaBattleMenu::Result:
	{
		const TCHAR* Title = B.Result == ELigaBattleResult::Win ? TEXT("Победа!") : B.Result == ELigaBattleResult::Caught ? TEXT("Покемон пойман!")
			: B.Result == ELigaBattleResult::Lose ? TEXT("Поражение") : TEXT("Бой окончен");
		Col->AddSlot().AutoHeight().HAlign(HAlign_Right)
		[
			SNew(SBorder).BorderImage(&CardBrush).Padding(FMargin(26, 18))
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).Text(FText::FromString(Title)).Font(Font(26)).ColorAndOpacity(Accent)]
				+ SVerticalBox::Slot().AutoHeight().Padding(0, 10, 0, 0)
				[Button(TEXT("Продолжить  (E)"), FString(), ColorButton(Accent), White, [W] { if (W.IsValid()) W->BattleContinue(); }, true, 300.f)]
			]
		];
		break;
	}
	default:
		break;
	}
	return Col;
}

// ——— pause menu ———

TSharedRef<SWidget> SLigaHUDWidget::BuildMenu()
{
	FirstFocus.Reset();
	ULigaGameInstance* G = GI();
	if (!PC.IsValid() || PC->Mode != ELigaMode::Menu || !G) return SNullWidget::NullWidget;
	TWeakObjectPtr<ALigaPlayerController> W = PC;
	TSharedRef<SVerticalBox> Team = SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 10)[SNew(STextBlock).Text(FText::FromString(TEXT("Команда"))).Font(Font(20)).ColorAndOpacity(Ink)];
	if (G->Data.Team.Num() == 0)
	{
		Team->AddSlot().AutoHeight()[SNew(STextBlock).Text(FText::FromString(TEXT("Пока нет покемонов. Загляните к профессору Оуку!"))).Font(Font(14, false)).ColorAndOpacity(Muted)];
	}
	for (const FLigaPokemon& P : G->Data.Team)
	{
		const int32 MHP = LigaRules::MaxHp(P);
		const float R = FMath::Clamp(float(P.HP) / float(FMath::Max(1, MHP)), 0.f, 1.f);
		const LigaTypes::FNature* Nat = LigaTypes::FindNature(P.Nature);
		TSharedRef<SHorizontalBox> Types = SNew(SHorizontalBox);
		for (EPokeType T : LigaRules::TypesOf(P)) Types->AddSlot().AutoWidth().Padding(0, 0, 6, 0)[TypePill(T)];
		FString Moves;
		for (const FLigaMoveSlot& M : P.Moves)
		{
			const FLigaMove* Mv = FLigaDatabase::Get().Move(M.Id);
			Moves += (Moves.IsEmpty() ? TEXT("") : TEXT(" · ")) + (Mv ? Mv->Name : M.Id);
		}
		Team->AddSlot().AutoHeight().Padding(0, 4)
		[
			SNew(SBox).WidthOverride(560)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[MonImage(P.Species, P.bShiny, 84)]
				+ SHorizontalBox::Slot().FillWidth(1).VAlign(VAlign_Center).Padding(12, 0, 0, 0)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight()
					[SNew(STextBlock).Font(Font(17)).ColorAndOpacity(Ink).Text(FText::FromString(FString::Printf(TEXT("%s%s  ур. %d"), P.bShiny ? TEXT("✦ ") : TEXT(""), *LigaRules::DisplayName(P), P.Level)))]
					+ SVerticalBox::Slot().AutoHeight().Padding(0, 3)[Types]
					+ SVerticalBox::Slot().AutoHeight().Padding(0, 3)
					[
						SNew(SHorizontalBox)
						+ SHorizontalBox::Slot().FillWidth(1).VAlign(VAlign_Center)[SNew(SBox).HeightOverride(9)[SNew(SProgressBar).Style(&HpStyle).Percent(R).FillColorAndOpacity(HpColor(R))]]
						+ SHorizontalBox::Slot().AutoWidth().Padding(10, 0, 0, 0)[SNew(STextBlock).Font(Font(12)).ColorAndOpacity(Ink).Text(FText::FromString(FString::Printf(TEXT("%d/%d"), P.HP, MHP)))]
					]
					+ SVerticalBox::Slot().AutoHeight()
					[SNew(STextBlock).Font(Font(11, false)).ColorAndOpacity(Muted).AutoWrapText(true)
						.Text(FText::FromString(FString::Printf(TEXT("Характер: %s · %s"), Nat ? Nat->Name : TEXT("?"), *Moves)))]
				]
			]
		];
	}
	FString BagText;
	for (const FLigaItem& It : FLigaDatabase::Get().Items())
	{
		const int32 N = G->Data.ItemCount(It.Id);
		if (N > 0) BagText += FString::Printf(TEXT("%s ×%d\n"), *It.Name, N);
	}
	int32 Caught = 0;
	int32 Seen = 0;
	for (const TPair<int32, uint8>& D : G->Data.Dex)
	{
		Seen += 1;
		Caught += D.Value >= 2 ? 1 : 0;
	}
	const int32 Minutes = (int32)(G->Data.PlaySeconds / 60.0);
	TSharedRef<SVerticalBox> Side = SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).Text(FText::FromString(G->Data.PlayerName)).Font(Font(20)).ColorAndOpacity(Ink)]
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 6)
		[
			SNew(STextBlock).Font(Font(13, false)).ColorAndOpacity(Ink)
			.Text(FText::FromString(FString::Printf(TEXT("Монеты: %d\nПокедекс: видели %d, поймали %d\nВремя в игре: %d ч %02d мин"),
				G->Data.Money, Seen, Caught, Minutes / 60, Minutes % 60)))
		]
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 10, 0, 4)[SNew(STextBlock).Text(FText::FromString(TEXT("Сумка"))).Font(Font(16)).ColorAndOpacity(Ink)]
		+ SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).Text(FText::FromString(BagText.IsEmpty() ? TEXT("Пусто") : BagText)).Font(Font(13, false)).ColorAndOpacity(Muted)]
		+ SVerticalBox::Slot().FillHeight(1)[SNew(SSpacer)]
		+ SVerticalBox::Slot().AutoHeight()[Button(TEXT("Продолжить"), FString(), ColorButton(Accent), FLinearColor::White, [W] { if (W.IsValid()) W->ToggleMenu(); }, true, 300.f)]
		+ SVerticalBox::Slot().AutoHeight()[Button(TEXT("Сохранить игру"), FString(), ColorButton(Hex(TEXT("22A35A"))), FLinearColor::White, [W] { if (W.IsValid()) W->SaveFromMenu(); }, true, 300.f)]
		+ SVerticalBox::Slot().AutoHeight()[Button(TEXT("Выйти из игры"), TEXT("Игра сохранится"), &DarkButton, FLinearColor::White, [W] { if (W.IsValid()) W->QuitGame(); }, true, 300.f)];

	return SNew(SBorder).BorderImage(&CardBrush).Padding(FMargin(32, 26))
	[
		SNew(SHorizontalBox)
		+ SHorizontalBox::Slot().AutoWidth()[Team]
		+ SHorizontalBox::Slot().AutoWidth().Padding(36, 0, 0, 0)[SNew(SBox).WidthOverride(320).MinDesiredHeight(460)[Side]]
	];
}

void SLigaHUDWidget::Refresh()
{
	if (!PC.IsValid()) return;
	if (const ULigaGameInstance* G = GI(); G && TeamBox.IsValid())
	{
		FString Sig;
		for (const FLigaPokemon& P : G->Data.Team)
		{
			Sig += FString::Printf(TEXT("%d/%d/%d/%d/%d/%d;"), P.Uid, P.Species, P.Level, P.HP, (int32)P.Status, P.bShiny ? 1 : 0);
		}
		if (Sig != TeamSignature)
		{
			TeamSignature = Sig;
			TeamBox->SetContent(BuildTeamStrip());
		}
	}
	if (PC->UiSerial != LastSerial)
	{
		LastSerial = PC->UiSerial;
		FirstFocus.Reset();
		if (ChoiceBox.IsValid()) ChoiceBox->SetContent(BuildChoice());
		TSharedPtr<SWidget> ChoiceFocus = FirstFocus;
		if (CommandBox.IsValid()) CommandBox->SetContent(BuildCommands());
		TSharedPtr<SWidget> CommandFocus = FirstFocus;
		if (MenuBox.IsValid()) MenuBox->SetContent(BuildMenu());
		TSharedPtr<SWidget> Focus = PC->Mode == ELigaMode::Choice ? ChoiceFocus : PC->Mode == ELigaMode::Battle ? CommandFocus : FirstFocus;
		if (Focus.IsValid() && FSlateApplication::IsInitialized()) FSlateApplication::Get().SetKeyboardFocus(Focus, EFocusCause::SetDirectly);
	}
}

// ——— HUD actor ———

ALigaHUD::ALigaHUD()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.bTickEvenWhenPaused = true;
}

void ALigaHUD::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (Widget.IsValid()) Widget->Refresh();
}

void ALigaHUD::BeginPlay()
{
	Super::BeginPlay();
	if (!GEngine || !GEngine->GameViewport) return;
	SAssignNew(Widget, SLigaHUDWidget).Owner(Cast<ALigaPlayerController>(GetOwningPlayerController()));
	Container = SNew(SWeakWidget).PossiblyNullContent(Widget);
	GEngine->GameViewport->AddViewportWidgetContent(Container.ToSharedRef(), 10);
}

void ALigaHUD::EndPlay(const EEndPlayReason::Type Reason)
{
	if (GEngine && GEngine->GameViewport && Container.IsValid())
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(Container.ToSharedRef());
	}
	Container.Reset();
	Widget.Reset();
	Super::EndPlay(Reason);
}

void ALigaHUD::DrawHUD()
{
	Super::DrawHUD();
	const ALigaPlayerController* PC = Cast<ALigaPlayerController>(GetOwningPlayerController());
	ALigaBattleStage* S = PC ? PC->Stage.Get() : nullptr;
	if (!S || !Canvas || !GEngine) return;
	UFont* F = GEngine->GetLargeFont();
	for (const FLigaPopup& P : S->Popups)
	{
		const FVector Screen = Project(P.World + FVector(0, 0, P.Age * 70.f));
		if (Screen.Z <= 0.f) continue;
		const float Alpha = FMath::Clamp(1.f - FMath::Max(0.f, P.Age - 0.7f) * 1.6f, 0.f, 1.f);
		const float Scale = 2.4f * (P.Age < 0.15f ? 0.6f + P.Age * 2.7f : 1.f);
		float W = 0.f, H = 0.f;
		Canvas->StrLen(F, P.Text, W, H);
		const float X = Screen.X - W * Scale * 0.5f;
		const float Y = Screen.Y - H * Scale * 0.5f;
		Canvas->SetDrawColor(FColor(20, 24, 43, (uint8)(255 * Alpha)));
		for (const FVector2D& O : {FVector2D(-2, 0), FVector2D(2, 0), FVector2D(0, -2), FVector2D(0, 3)})
		{
			Canvas->DrawText(F, P.Text, X + O.X, Y + O.Y, Scale, Scale);
		}
		Canvas->SetDrawColor(P.Color.CopyWithNewOpacity(Alpha).ToFColor(true));
		Canvas->DrawText(F, P.Text, X, Y, Scale, Scale);
	}
}
