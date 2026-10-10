#include "LigaData.h"

#include "Dom/JsonObject.h"
#include "LigaJson.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

DEFINE_LOG_CATEGORY_STATIC(LogLigaData, Log, All);

FLigaDatabase& FLigaDatabase::Get()
{
	static FLigaDatabase Instance;
	if (!Instance.bLoaded) Instance.Load();
	return Instance;
}

FString FLigaDatabase::DataDir()
{
	return FPaths::ProjectContentDir() / TEXT("Liga/Data");
}

bool FLigaDatabase::Load()
{
	if (bLoaded) return true;
	const bool bOk = LoadSpecies(DataDir() / TEXT("species.json")) && LoadMoves(DataDir() / TEXT("moves.json"));
	FixClassicEvolutions();
	BuildItems();
	BuildEncounters();
	bLoaded = bOk;
	UE_LOG(LogLigaData, Log, TEXT("Liga data: %d species, %d moves (%s)"), SpeciesList.Num(), Moves.Num(), bOk ? TEXT("ok") : TEXT("FAILED"));
	return bOk;
}

static bool ReadJsonArray(const FString& Path, TArray<TSharedPtr<FJsonValue>>& Out)
{
	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *Path))
	{
		UE_LOG(LogLigaData, Error, TEXT("Cannot read %s"), *Path);
		return false;
	}
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
	if (!FJsonSerializer::Deserialize(Reader, Out))
	{
		UE_LOG(LogLigaData, Error, TEXT("Bad JSON in %s"), *Path);
		return false;
	}
	return true;
}

bool FLigaDatabase::LoadSpecies(const FString& Path)
{
	TArray<TSharedPtr<FJsonValue>> Arr;
	if (!ReadJsonArray(Path, Arr)) return false;
	SpeciesList.Reset();
	SpeciesList.SetNum(Arr.Num());
	for (const TSharedPtr<FJsonValue>& V : Arr)
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		if (!O) continue;
		FLigaSpecies S;
		S.Id = O->GetIntegerField(TEXT("id"));
		S.Name = O->GetStringField(TEXT("name"));
		O->TryGetStringField(TEXT("en"), S.En);
		for (const TSharedPtr<FJsonValue>& T : O->GetArrayField(TEXT("types"))) S.Types.Add(LigaTypes::Parse(T->AsString()));
		const TArray<TSharedPtr<FJsonValue>>& Base = O->GetArrayField(TEXT("base"));
		for (int32 i = 0; i < ST_Count && i < Base.Num(); ++i) S.Base[i] = (int32)Base[i]->AsNumber();
		S.CatchRate = O->GetIntegerField(TEXT("catch"));
		S.BaseExp = O->GetIntegerField(TEXT("exp"));
		S.Growth = O->GetStringField(TEXT("growth"));
		double Male = -1.0;
		S.MaleRatio = O->TryGetNumberField(TEXT("male"), Male) ? (float)Male : -1.f;
		S.Stage = O->GetIntegerField(TEXT("stage"));
		double H = 1.0;
		if (O->TryGetNumberField(TEXT("height"), H)) S.Height = (float)H;
		O->TryGetNumberField(TEXT("gen"), S.Gen);
		int32 Flag = 0;
		if (O->TryGetNumberField(TEXT("legendary"), Flag)) S.bLegendary = Flag != 0;
		if (O->TryGetNumberField(TEXT("mythical"), Flag)) S.bMythical = Flag != 0;
		const TArray<TSharedPtr<FJsonValue>>* Evos;
		if (O->TryGetArrayField(TEXT("evolutions"), Evos))
		{
			for (const TSharedPtr<FJsonValue>& E : *Evos)
			{
				const TSharedPtr<FJsonObject> EO = E->AsObject();
				FLigaEvolution Evo;
				Evo.To = EO->GetIntegerField(TEXT("to"));
				EO->TryGetNumberField(TEXT("level"), Evo.Level);
				EO->TryGetStringField(TEXT("item"), Evo.Item);
				EO->TryGetStringField(TEXT("time"), Evo.Time);
				S.Evolutions.Add(Evo);
			}
		}
		for (const TSharedPtr<FJsonValue>& L : O->GetArrayField(TEXT("learnset")))
		{
			const TArray<TSharedPtr<FJsonValue>>& Pair = L->AsArray();
			if (Pair.Num() == 2) S.Learnset.Add(TPair<int32, FString>((int32)Pair[0]->AsNumber(), Pair[1]->AsString()));
		}
		if (S.Id >= 1 && S.Id <= SpeciesList.Num()) SpeciesList[S.Id - 1] = MoveTemp(S);
	}
	return SpeciesList.Num() > 0;
}

void FLigaDatabase::FixClassicEvolutions()
{
	// PokeAPI keeps one evolution list per species, and for some of them it is the list of a regional form: Alolan
	// Sandshrew (Ice Stone), Hisuian Voltorb (Leaf Stone), Galarian Slowpoke, Farfetch'd, Mr. Mime, Corsola, Hisuian
	// Qwilfish and Sneasel. The Pokémon of this game are the Kanto and Johto ones, so they evolve as in those games.
	auto Set = [this](int32 Id, TArray<FLigaEvolution> Evos)
	{
		if (SpeciesList.IsValidIndex(Id - 1) && SpeciesList[Id - 1].Id == Id) SpeciesList[Id - 1].Evolutions = MoveTemp(Evos);
	};
	auto Lv = [](int32 To, int32 Level)
	{
		FLigaEvolution E;
		E.To = To;
		E.Level = Level;
		return E;
	};
	auto ByItem = [](int32 To, const TCHAR* ItemId)
	{
		FLigaEvolution E;
		E.To = To;
		E.Item = ItemId;
		return E;
	};
	Set(27, {Lv(28, 22)});                                     // Sandshrew → Sandslash at 22
	Set(52, {Lv(53, 28)});                                     // Meowth → Persian (not Perrserker)
	Set(79, {Lv(80, 37), ByItem(199, TEXT("kings-rock"))});    // Slowpoke → Slowbro at 37, Slowking by trade holding a King's Rock
	Set(83, {});                                               // Farfetch'd does not evolve
	Set(100, {Lv(101, 30)});                                   // Voltorb → Electrode at 30
	Set(122, {});                                              // Mr. Mime does not evolve
	Set(194, {Lv(195, 20)});                                   // Wooper → Quagsire (not Clodsire)
	Set(211, {});                                              // Qwilfish does not evolve
	Set(215, {ByItem(461, TEXT("razor-claw"))});               // Sneasel → Weavile (not Sneasler)
	Set(222, {});                                              // Corsola does not evolve
}

bool FLigaDatabase::LoadMoves(const FString& Path)
{
	TArray<TSharedPtr<FJsonValue>> Arr;
	if (!ReadJsonArray(Path, Arr)) return false;
	for (const TSharedPtr<FJsonValue>& V : Arr)
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		if (!O) continue;
		FLigaMove M;
		M.Id = O->GetStringField(TEXT("id"));
		M.Name = O->GetStringField(TEXT("name"));
		M.Type = LigaTypes::Parse(O->GetStringField(TEXT("type")));
		const FString Cat = O->GetStringField(TEXT("category"));
		M.Category = Cat == TEXT("physical") ? EMoveCategory::Physical : Cat == TEXT("special") ? EMoveCategory::Special : EMoveCategory::Status;
		O->TryGetNumberField(TEXT("power"), M.Power);
		double Acc = 0;
		M.Accuracy = O->TryGetNumberField(TEXT("accuracy"), Acc) ? (int32)Acc : -1;
		O->TryGetNumberField(TEXT("pp"), M.PP);
		O->TryGetNumberField(TEXT("priority"), M.Priority);

		const TSharedPtr<FJsonObject>* FxPtr;
		if (O->TryGetObjectField(TEXT("effect"), FxPtr) && FxPtr->IsValid())
		{
			const TSharedPtr<FJsonObject>& Fx = *FxPtr;
			FLigaMoveEffect& E = M.Effect;
			const TSharedPtr<FJsonObject>* Sub;
			if (Fx->TryGetObjectField(TEXT("status"), Sub))
			{
				E.Status = LigaTypes::ParseStatus((*Sub)->GetStringField(TEXT("id")));
				E.StatusChance = (*Sub)->GetIntegerField(TEXT("chance"));
			}
			if (Fx->TryGetObjectField(TEXT("stats"), Sub))
			{
				E.bHasStats = true;
				E.bStatsSelf = (*Sub)->GetStringField(TEXT("target")) == TEXT("self");
				(*Sub)->TryGetNumberField(TEXT("chance"), E.StatsChance);
				const TSharedPtr<FJsonObject>* Ch;
				if ((*Sub)->TryGetObjectField(TEXT("changes"), Ch))
				{
					for (const auto& KV : (*Ch)->Values)
					{
						const int32 Stat = LigaTypes::ParseBattleStat(LigaJsonKey(KV.Key));
						if (Stat >= 0) E.StatChanges[Stat] = (int32)KV.Value->AsNumber();
					}
				}
			}
			Fx->TryGetNumberField(TEXT("confuse"), E.ConfuseChance);
			Fx->TryGetNumberField(TEXT("flinch"), E.Flinch);
			double D = 0;
			if (Fx->TryGetNumberField(TEXT("drain"), D)) E.Drain = (float)D;
			if (Fx->TryGetNumberField(TEXT("recoil"), D)) E.Recoil = (float)D;
			if (Fx->TryGetNumberField(TEXT("heal"), D)) E.Heal = (float)D;
			const TArray<TSharedPtr<FJsonValue>>* Hits;
			if (Fx->TryGetArrayField(TEXT("multiHit"), Hits) && Hits->Num() == 2)
			{
				E.MultiHitMin = (int32)(*Hits)[0]->AsNumber();
				E.MultiHitMax = (int32)(*Hits)[1]->AsNumber();
			}
			if (const TSharedPtr<FJsonValue> Fixed = Fx->TryGetField(TEXT("fixedDamage")))
			{
				if (Fixed->Type == EJson::String)
				{
					E.FixedDamage = Fixed->AsString() == TEXT("level") ? -2 : -3;
				}
				else
				{
					E.FixedDamage = (int32)Fixed->AsNumber();
				}
			}
			bool B = false;
			if (Fx->TryGetBoolField(TEXT("highCrit"), B)) E.bHighCrit = B;
			if (Fx->TryGetBoolField(TEXT("rest"), B)) E.bRest = B;
			if (Fx->TryGetBoolField(TEXT("flee"), B)) E.bFlee = B;
			if (Fx->TryGetBoolField(TEXT("payDay"), B)) E.bPayDay = B;
			if (Fx->TryGetBoolField(TEXT("hex"), B)) E.bHex = B;
			if (Fx->TryGetBoolField(TEXT("protect"), B)) E.bProtect = B;
			if (Fx->TryGetBoolField(TEXT("recharge"), B)) E.bRecharge = B;
			if (Fx->TryGetBoolField(TEXT("selfKO"), B)) E.bSelfKO = B;
			if (Fx->TryGetBoolField(TEXT("ohko"), B)) E.bOHKO = B;
		}
		Moves.Add(M.Id, MoveTemp(M));
	}
	return Moves.Num() > 0;
}

void FLigaDatabase::BuildItems()
{
	auto Add = [this](const TCHAR* Id, const TCHAR* Name, const TCHAR* Kind, int32 Price, const TCHAR* Desc) -> FLigaItem&
	{
		FLigaItem& It = ItemList.AddDefaulted_GetRef();
		It.Id = Id;
		It.Name = Name;
		It.Kind = Kind;
		It.Price = Price;
		It.Desc = Desc;
		return It;
	};
	ItemList.Reset();
	Add(TEXT("poke-ball"), TEXT("Покебол"), TEXT("ball"), 200, TEXT("Обычный покебол для ловли диких покемонов.")).Ball = 1.f;
	Add(TEXT("great-ball"), TEXT("Супербол"), TEXT("ball"), 600, TEXT("Ловит в 1,5 раза лучше обычного покебола.")).Ball = 1.5f;
	Add(TEXT("ultra-ball"), TEXT("Ультрабол"), TEXT("ball"), 1200, TEXT("Ловит в 2 раза лучше обычного покебола.")).Ball = 2.f;
	Add(TEXT("master-ball"), TEXT("Мастербол"), TEXT("ball"), 0, TEXT("Ловит любого покемона без промаха.")).Ball = 255.f;
	Add(TEXT("potion"), TEXT("Зелье"), TEXT("heal"), 300, TEXT("Восстанавливает 20 HP.")).Heal = 20;
	Add(TEXT("super-potion"), TEXT("Суперзелье"), TEXT("heal"), 700, TEXT("Восстанавливает 60 HP.")).Heal = 60;
	Add(TEXT("hyper-potion"), TEXT("Гиперзелье"), TEXT("heal"), 1200, TEXT("Восстанавливает 120 HP.")).Heal = 120;
	Add(TEXT("max-potion"), TEXT("Максизелье"), TEXT("heal"), 2500, TEXT("Полностью восстанавливает HP.")).Heal = -1;
	Add(TEXT("antidote"), TEXT("Противоядие"), TEXT("status"), 100, TEXT("Излечивает отравление.")).Cure = EStatus::Poison;
	Add(TEXT("paralyze-heal"), TEXT("Антипаралитик"), TEXT("status"), 200, TEXT("Излечивает паралич.")).Cure = EStatus::Paralysis;
	Add(TEXT("awakening"), TEXT("Будильник"), TEXT("status"), 250, TEXT("Будит уснувшего покемона.")).Cure = EStatus::Sleep;
	Add(TEXT("burn-heal"), TEXT("Мазь от ожогов"), TEXT("status"), 250, TEXT("Излечивает ожог.")).Cure = EStatus::Burn;
	Add(TEXT("ice-heal"), TEXT("Размораживатель"), TEXT("status"), 250, TEXT("Размораживает покемона.")).Cure = EStatus::Freeze;
	Add(TEXT("full-heal"), TEXT("Полное лечение"), TEXT("status"), 600, TEXT("Излечивает любой статус.")).bCureAll = true;
	Add(TEXT("revive"), TEXT("Оживитель"), TEXT("revive"), 1500, TEXT("Оживляет покемона с половиной HP.")).Revive = 0.5f;
	Add(TEXT("ether"), TEXT("Эфир"), TEXT("pp"), 1200, TEXT("Восстанавливает 10 PP всем атакам.")).PP = 10;
	Add(TEXT("oaks-parcel"), TEXT("Посылка Оука"), TEXT("key"), 0, TEXT("Посылка из магазина для профессора Оука."));
	Add(TEXT("old-rod"), TEXT("Старая удочка"), TEXT("key"), 0, TEXT("Встаньте на краю мостков или пристани и закиньте удочку."));
	// Evolution: stones and other items used from the bag ("evo"), items held during a trade at the Trainers' Club ("trade"),
	// and the Soothe Bell that makes a Pokémon friendlier ("friend"). The species data names these items in its evolutions.
	Add(TEXT("fire-stone"), TEXT("Огненный камень"), TEXT("evo"), 1500, TEXT("Эволюция: Вульпикс, Гроулит, Иви."));
	Add(TEXT("water-stone"), TEXT("Водный камень"), TEXT("evo"), 1500, TEXT("Эволюция: Поливирл, Шеллдер, Старью, Иви."));
	Add(TEXT("thunder-stone"), TEXT("Громовой камень"), TEXT("evo"), 1500, TEXT("Эволюция: Пикачу, Иви, Магнетон."));
	Add(TEXT("leaf-stone"), TEXT("Листовой камень"), TEXT("evo"), 1500, TEXT("Эволюция: Глум, Випинбелл, Экзеггут, Иви."));
	Add(TEXT("moon-stone"), TEXT("Лунный камень"), TEXT("evo"), 1500, TEXT("Эволюция: Нидорина, Нидорино, Клефейри, Джиглипафф."));
	Add(TEXT("sun-stone"), TEXT("Солнечный камень"), TEXT("evo"), 1500, TEXT("Эволюция: Глум (в Беллоссома), Санкерн."));
	Add(TEXT("ice-stone"), TEXT("Ледяной камень"), TEXT("evo"), 1500, TEXT("Эволюция: Иви (в Гласеона)."));
	Add(TEXT("shiny-stone"), TEXT("Сияющий камень"), TEXT("evo"), 2000, TEXT("Эволюция: Иви (в Сильвеона), Тогетик."));
	Add(TEXT("dusk-stone"), TEXT("Камень сумерек"), TEXT("evo"), 2000, TEXT("Эволюция: Маркроу, Мисдривус."));
	Add(TEXT("razor-claw"), TEXT("Острый коготь"), TEXT("evo"), 2000, TEXT("Эволюция: Снизел."));
	Add(TEXT("razor-fang"), TEXT("Острый клык"), TEXT("evo"), 2000, TEXT("Эволюция: Глайгер."));
	Add(TEXT("black-augurite"), TEXT("Чёрный авгурит"), TEXT("evo"), 2000, TEXT("Эволюция: Скайтер (в Кливора)."));
	Add(TEXT("peat-block"), TEXT("Торфяной брикет"), TEXT("evo"), 2000, TEXT("Эволюция: Урсаринг."));
	Add(TEXT("kings-rock"), TEXT("Королевский камень"), TEXT("trade"), 2500, TEXT("Обмен в Клубе тренеров: Поливирл станет Политодом, Слоупок — Слоукингом."));
	Add(TEXT("metal-coat"), TEXT("Металлическое покрытие"), TEXT("trade"), 2500, TEXT("Обмен в Клубе тренеров: Оникс — Стиликсом, Скайтер — Сизором."));
	Add(TEXT("dragon-scale"), TEXT("Драконья чешуя"), TEXT("trade"), 2500, TEXT("Обмен в Клубе тренеров: Сидра станет Кингдрой."));
	Add(TEXT("up-grade"), TEXT("Апгрейд"), TEXT("trade"), 2500, TEXT("Обмен в Клубе тренеров: Поригон станет Поригоном 2."));
	Add(TEXT("dubious-disc"), TEXT("Сомнительный диск"), TEXT("trade"), 2500, TEXT("Обмен в Клубе тренеров: Поригон 2 станет Поригоном-Z."));
	Add(TEXT("protector"), TEXT("Протектор"), TEXT("trade"), 2500, TEXT("Обмен в Клубе тренеров: Райдон станет Райпериором."));
	Add(TEXT("electirizer"), TEXT("Электрайзер"), TEXT("trade"), 2500, TEXT("Обмен в Клубе тренеров: Электабазз станет Элективайром."));
	Add(TEXT("magmarizer"), TEXT("Магмарайзер"), TEXT("trade"), 2500, TEXT("Обмен в Клубе тренеров: Магмар станет Магмортаром."));
	Add(TEXT("soothe-bell"), TEXT("Успокаивающий колокольчик"), TEXT("friend"), 2000, TEXT("Покемон слышит его звон и становится дружелюбнее (+50 к дружбе)."));
}

void FLigaDatabase::BuildEncounters()
{
	// {species, min level, max level, weight}. A table "<route>@night" (or "@day") is added to "<route>" at that time of
	// day by the computer clock (ULigaGameInstance::RollWild).
	// Route 1 as in FireRed/LeafGreen plus a few guests.
	EncounterTables.Add(TEXT("route1"), {
		{16, 2, 5, 30},   // Пиджи
		{19, 2, 4, 26},   // Раттата
		{10, 2, 4, 7},    // Катерпи
		{13, 2, 4, 7},    // Видл
		{21, 3, 5, 6},    // Спироу
		{29, 2, 4, 4},    // Нидоран♀
		{32, 2, 4, 4},    // Нидоран♂
		{52, 2, 4, 3},    // Мяут
		{56, 3, 5, 3},    // Манки
		{23, 3, 5, 2},    // Эканс
		{27, 3, 5, 2},    // Сэндшру
		{39, 3, 5, 2},    // Джигглипуф
		{25, 3, 5, 2},    // Пикачу
		{161, 2, 4, 2},   // Сентрет
		{133, 4, 5, 1},   // Иви
		{17, 8, 9, 1},    // Пиджеотто
	});
	// At night (the computer clock, 18:00–6:00) other Pokémon come out.
	EncounterTables.Add(TEXT("route1@night"), {
		{163, 2, 5, 18},  // Хутхут
		{41, 3, 5, 8},    // Зубат
		{48, 3, 5, 6},    // Венонат
		{92, 4, 5, 3},    // Гастли
		{198, 4, 5, 2},   // Маркроу
	});
	// The northern half of Route 1, towards Viridian City.
	EncounterTables.Add(TEXT("route1_north"), {
		{16, 3, 6, 20},   // Пиджи
		{19, 3, 6, 16},   // Раттата
		{21, 4, 6, 10},   // Спироу
		{56, 4, 6, 7},    // Манки
		{52, 4, 6, 7},    // Мяут
		{23, 4, 6, 6},    // Эканс
		{27, 4, 6, 6},    // Сэндшру
		{43, 4, 6, 6},    // Оддиш
		{69, 4, 6, 6},    // Беллспраут
		{29, 4, 6, 4},    // Нидоран♀
		{32, 4, 6, 4},    // Нидоран♂
		{58, 4, 6, 4},    // Гроулит
		{37, 4, 6, 4},    // Вульпикс
		{84, 5, 7, 3},    // Додуо
		{77, 5, 7, 2},    // Понита
		{25, 4, 6, 3},    // Пикачу
		{63, 5, 7, 2},    // Абра
		{39, 4, 6, 3},    // Джигглипуф
		{96, 5, 7, 3},    // Дроузи
		{209, 5, 7, 2},   // Снаббл
		{231, 5, 7, 2},   // Фанфи
		{133, 5, 6, 1},   // Иви
		{17, 9, 11, 2},   // Пиджеотто
		{20, 9, 11, 1},   // Рэтикейт
		{30, 9, 10, 1},   // Нидорина
		{33, 9, 10, 1},   // Нидорино
		{241, 8, 10, 1},  // Милтанк
	});
	EncounterTables.Add(TEXT("route1_north@night"), {
		{163, 4, 7, 16},  // Хутхут
		{41, 4, 7, 8},    // Зубат
		{92, 5, 7, 4},    // Гастли
		{228, 5, 7, 3},   // Хаундаур
		{198, 5, 7, 2},   // Маркроу
		{215, 6, 7, 1},   // Снизел
	});
	// The forest edge north-west of Pallet Town: mostly bugs and grass Pokémon.
	EncounterTables.Add(TEXT("forest"), {
		{10, 3, 5, 16},   // Катерпи
		{13, 3, 5, 16},   // Видл
		{11, 4, 6, 6},    // Метапод
		{14, 4, 6, 6},    // Какуна
		{43, 3, 6, 10},   // Оддиш
		{69, 3, 6, 8},    // Беллспраут
		{46, 4, 6, 8},    // Парас
		{48, 4, 6, 7},    // Венонат
		{165, 3, 6, 6},   // Ледиба
		{167, 3, 6, 4},   // Спинарак
		{204, 4, 6, 5},   // Пайнеко
		{102, 4, 6, 3},   // Экзеггут
		{25, 4, 6, 4},    // Пикачу
		{191, 4, 6, 3},   // Санкерн
		{193, 5, 7, 2},   // Янма
		{114, 5, 7, 2},   // Тангела
		{12, 6, 8, 1},    // Баттерфри
		{15, 6, 8, 1},    // Бидрилл
		{123, 7, 9, 1},   // Скайтер
		{127, 7, 9, 1},   // Пинсир
		{214, 7, 9, 1},   // Геракросс
		{213, 6, 8, 1},   // Шакл
		{1, 5, 5, 1},     // Бульбазавр
	});
	EncounterTables.Add(TEXT("forest@night"), {
		{163, 4, 7, 14},  // Хутхут
		{167, 4, 7, 10},  // Спинарак
		{48, 4, 7, 6},    // Венонат
		{92, 5, 7, 4},    // Гастли
		{200, 6, 7, 2},   // Мисдривус
		{198, 6, 7, 2},   // Маркроу
		{216, 6, 7, 2},   // Теддиурса
	});
	// The tall grass by the pond of Pallet Town.
	EncounterTables.Add(TEXT("pond"), {
		{54, 3, 6, 16},   // Псидак
		{60, 3, 6, 14},   // Поливаг
		{194, 3, 6, 10},  // Вупер
		{43, 3, 6, 10},   // Оддиш
		{69, 3, 6, 8},    // Беллспраут
		{79, 4, 6, 8},    // Слоупок
		{48, 4, 6, 6},    // Венонат
		{183, 4, 6, 6},   // Мэрилл
		{23, 4, 6, 5},    // Эканс
		{102, 4, 6, 4},   // Экзеггут
		{193, 5, 7, 3},   // Янма
		{114, 5, 7, 3},   // Тангела
		{61, 8, 10, 1},   // Поливирл
		{7, 5, 5, 1},     // Сквиртл
		{1, 5, 5, 1},     // Бульбазавр
	});
	EncounterTables.Add(TEXT("pond@night"), {
		{60, 4, 7, 10},   // Поливаг
		{194, 4, 7, 8},   // Вупер
		{163, 4, 6, 6},   // Хутхут
		{48, 4, 7, 5},    // Венонат
	});
	// What bites on the old rod.
	EncounterTables.Add(TEXT("fishing_pond"), {
		{129, 4, 8, 36},  // Мэджикарп
		{118, 4, 8, 22},  // Голдин
		{60, 4, 8, 18},   // Поливаг
		{54, 5, 8, 8},    // Псидак
		{79, 5, 8, 5},    // Слоупок
		{194, 5, 8, 5},   // Вупер
		{183, 5, 8, 4},   // Мэрилл
		{147, 6, 8, 2},   // Дратини
		{119, 12, 14, 1}, // Сикинг
	});
	EncounterTables.Add(TEXT("fishing_sea"), {
		{129, 4, 8, 28},  // Мэджикарп
		{72, 5, 8, 16},   // Тентакул
		{98, 5, 8, 11},   // Крабби
		{116, 5, 8, 11},  // Хорси
		{90, 5, 8, 9},    // Шеллдер
		{120, 5, 8, 8},   // Старью
		{86, 6, 8, 5},    // Сил
		{170, 5, 8, 5},   // Чинчоу
		{223, 5, 8, 4},   // Реморейд
		{138, 8, 10, 1},  // Оманайт
		{140, 8, 10, 1},  // Кабуто
		{131, 10, 12, 1}, // Лапрас
		{130, 10, 12, 1}, // Гаярдос
	});
	// Johto: Route 29, the beach of New Bark Town and its jetty.
	EncounterTables.Add(TEXT("route29"), {
		{161, 2, 5, 26},  // Сентрет
		{16, 2, 5, 16},   // Пиджи
		{19, 2, 5, 12},   // Раттата
		{163, 2, 5, 10},  // Хутхут
		{187, 3, 5, 10},  // Хоппип
		{165, 3, 5, 6},   // Ледиба
		{167, 3, 5, 6},   // Спинарак
		{204, 3, 5, 4},   // Пайнеко
		{220, 3, 5, 3},   // Свайнаб
		{209, 3, 5, 3},   // Снаббл
		{172, 3, 5, 2},   // Пичу
		{175, 3, 3, 1},   // Тогепи
	});
	EncounterTables.Add(TEXT("route29@night"), {
		{163, 2, 5, 20},  // Хутхут
		{167, 2, 5, 10},  // Спинарак
		{198, 3, 5, 3},   // Маркроу
		{92, 3, 5, 3},    // Гастли
		{200, 4, 5, 1},   // Мисдривус
	});
	EncounterTables.Add(TEXT("route29_west"), {
		{161, 4, 7, 18},  // Сентрет
		{163, 4, 7, 10},  // Хутхут
		{187, 4, 7, 12},  // Хоппип
		{179, 4, 7, 8},   // Мэрип
		{191, 4, 7, 7},   // Санкерн
		{165, 4, 7, 6},   // Ледиба
		{167, 4, 7, 6},   // Спинарак
		{177, 5, 7, 5},   // Нату
		{190, 5, 7, 4},   // Эйпом
		{206, 5, 7, 3},   // Данспорс
		{174, 4, 6, 2},   // Игглибафф
		{203, 5, 7, 3},   // Жирафариг
		{234, 5, 7, 3},   // Стэнтлер
		{231, 5, 7, 3},   // Фанфи
		{216, 5, 7, 3},   // Теддиурса
		{228, 5, 7, 2},   // Хаундаур
		{235, 6, 8, 2},   // Смиргл
		{207, 6, 8, 2},   // Глайгер
		{185, 7, 8, 1},   // Судовудо
		{202, 6, 8, 1},   // Воббафет
		{227, 8, 9, 1},   // Скармори
		{246, 7, 8, 1},   // Ларвитар
		{133, 6, 7, 1},   // Иви
		{162, 10, 11, 1}, // Фуррет
	});
	EncounterTables.Add(TEXT("route29_west@night"), {
		{163, 5, 8, 14},  // Хутхут
		{167, 5, 8, 8},   // Спинарак
		{198, 6, 8, 4},   // Маркроу
		{200, 6, 8, 3},   // Мисдривус
		{215, 6, 8, 3},   // Снизел
		{228, 6, 8, 3},   // Хаундаур
		{201, 7, 8, 1},   // Аноун
	});
	EncounterTables.Add(TEXT("newbark_shore"), {
		{194, 4, 7, 22},  // Вупер
		{183, 4, 7, 18},  // Мэрилл
		{72, 4, 7, 12},   // Тентакул
		{170, 5, 7, 9},   // Чинчоу
		{98, 4, 7, 8},    // Крабби
		{222, 5, 7, 6},   // Корсола
		{54, 4, 7, 6},    // Псидак
		{211, 5, 7, 4},   // Квилфиш
		{79, 5, 7, 3},    // Слоупок
		{218, 5, 7, 3},   // Слагма
		{225, 6, 8, 2},   // Дэлибёд
		{86, 6, 8, 2},    // Сил
	});
	EncounterTables.Add(TEXT("fishing_johto"), {
		{129, 5, 9, 28},  // Мэджикарп
		{170, 5, 9, 16},  // Чинчоу
		{223, 5, 9, 14},  // Реморейд
		{211, 5, 9, 9},   // Квилфиш
		{222, 5, 9, 8},   // Корсола
		{90, 5, 9, 7},    // Шеллдер
		{98, 5, 9, 6},    // Крабби
		{118, 5, 9, 6},   // Голдин
		{116, 6, 9, 4},   // Хорси
		{226, 10, 12, 1}, // Мантин
		{131, 10, 12, 1}, // Лапрас
	});
	// The beach and the pier of Pallet Town.
	EncounterTables.Add(TEXT("shore"), {
		{72, 3, 7, 22},   // Тентакул
		{98, 3, 6, 16},   // Крабби
		{90, 4, 6, 9},    // Шеллдер
		{120, 4, 6, 9},   // Старью
		{54, 3, 6, 9},    // Псидак
		{79, 4, 6, 7},    // Слоупок
		{60, 3, 6, 7},    // Поливаг
		{116, 4, 6, 6},   // Хорси
		{118, 4, 6, 5},   // Голдин
		{194, 4, 6, 4},   // Вупер
		{86, 5, 7, 3},    // Сил
		{222, 5, 7, 2},   // Корсола
		{7, 5, 5, 1},     // Сквиртл
		{131, 8, 10, 1},  // Лапрас
		{138, 7, 8, 1},   // Оманайт
		{140, 7, 8, 1},   // Кабуто
	});
}

const FLigaSpecies* FLigaDatabase::Species(int32 Id) const
{
	return SpeciesList.IsValidIndex(Id - 1) && SpeciesList[Id - 1].Id == Id ? &SpeciesList[Id - 1] : nullptr;
}

const FLigaMove* FLigaDatabase::Move(const FString& Id) const
{
	return Moves.Find(Id);
}

const FLigaItem* FLigaDatabase::Item(const FString& Id) const
{
	return ItemList.FindByPredicate([&Id](const FLigaItem& It) { return It.Id == Id; });
}
