// Units read after a number. Adapted from NVIDIA NeMo-text-processing
// nemo_text_processing/text_normalization/en/data/measure/unit.tsv (Apache-2.0),
// re-cased, with plurals, and extended. See README.md.
//
// symbol <TAB> singular <TAB> plural [<TAB> flags]
// British spellings (metre, litre) are derived from the American ones.
// Flags: R = risky when spaced ("5 in a row", "1 in 5"): expanded only when attached,
//        before punctuation, or before a measuring word; A = attached only;
//        S = spaced form is fine but never before a counted noun ("5 m people" is million).

export default `
km	kilometer	kilometers
m	meter	meters	S
cm	centimeter	centimeters
mm	millimeter	millimeters
dm	decimeter	decimeters
μm	micrometer	micrometers
µm	micrometer	micrometers
nm	nanometer	nanometers
mi	mile	miles
ft	foot	feet
in	inch	inches	R
yd	yard	yards
nmi	nautical mile	nautical miles
sq ft	square foot	square feet
sq. ft.	square foot	square feet
sq in	square inch	square inches
sq m	square meter	square meters
sq km	square kilometer	square kilometers
sq mi	square mile	square miles
cu ft	cubic foot	cubic feet
cu in	cubic inch	cubic inches
cu mi	cubic mile	cubic miles
ha	hectare	hectares	R
kg	kilogram	kilograms
g	gram	grams
mg	milligram	milligrams
μg	microgram	micrograms
µg	microgram	micrograms
mcg	microgram	micrograms
ng	nanogram	nanograms
lb	pound	pounds
lbs	pound	pounds
oz	ounce	ounces
st	stone	stone	R
cwt	hundredweight	hundredweight
l	liter	liters	R
L	liter	liters
ml	milliliter	milliliters
mL	milliliter	milliliters
cl	centiliter	centiliters
dl	deciliter	deciliters
μl	microliter	microliters
μL	microliter	microliters
µl	microliter	microliters
µL	microliter	microliters
gal	gallon	gallons
qt	quart	quarts
fl oz	fluid ounce	fluid ounces
fl. oz.	fluid ounce	fluid ounces
tsp	teaspoon	teaspoons
tsps	teaspoon	teaspoons
tbsp	tablespoon	tablespoons
Tbsp	tablespoon	tablespoons
tbs	tablespoon	tablespoons
tbsps	tablespoon	tablespoons
cc	cubic centimeter	cubic centimeters
h	hour	hours
hr	hour	hours
hrs	hour	hours
min	minute	minutes
mins	minute	minutes
s	second	seconds	R
sec	second	seconds
secs	second	seconds
ms	millisecond	milliseconds
μs	microsecond	microseconds
µs	microsecond	microseconds
ns	nanosecond	nanoseconds
wk	week	weeks
wks	week	weeks
mo	month	months	R
mos	month	months
yr	year	years
yrs	year	years
mph	mile per hour	miles per hour
kph	kilometer per hour	kilometers per hour
kmh	kilometer per hour	kilometers per hour
km/h	kilometer per hour	kilometers per hour
m/s	meter per second	meters per second
ft/s	foot per second	feet per second
°C	degree Celsius	degrees Celsius
° C	degree Celsius	degrees Celsius
°F	degree Fahrenheit	degrees Fahrenheit
° F	degree Fahrenheit	degrees Fahrenheit
°	degree	degrees
KB	kilobyte	kilobytes
kB	kilobyte	kilobytes
MB	megabyte	megabytes
GB	gigabyte	gigabytes
TB	terabyte	terabytes
PB	petabyte	petabytes
KiB	kibibyte	kibibytes
MiB	mebibyte	mebibytes
GiB	gibibyte	gibibytes
TiB	tebibyte	tebibytes
kb	kilobit	kilobits
Kb	kilobit	kilobits
Mb	megabit	megabits
Gb	gigabit	gigabits
kbps	kilobit per second	kilobits per second
Kbps	kilobit per second	kilobits per second
Mbps	megabit per second	megabits per second
Gbps	gigabit per second	gigabits per second
Hz	hertz	hertz
kHz	kilohertz	kilohertz
MHz	megahertz	megahertz
GHz	gigahertz	gigahertz
THz	terahertz	terahertz
W	watt	watts	R
mW	milliwatt	milliwatts
kW	kilowatt	kilowatts
MW	megawatt	megawatts
GW	gigawatt	gigawatts
TW	terawatt	terawatts
Wh	watt hour	watt hours
kWh	kilowatt hour	kilowatt hours
MWh	megawatt hour	megawatt hours
GWh	gigawatt hour	gigawatt hours
TWh	terawatt hour	terawatt hours
V	volt	volts	R
mV	millivolt	millivolts
kV	kilovolt	kilovolts
mA	milliamp	milliamps
mAh	milliamp hour	milliamp hours
Ah	amp hour	amp hours
Ω	ohm	ohms
kΩ	kilohm	kilohms
MΩ	megohm	megohms
kJ	kilojoule	kilojoules
MJ	megajoule	megajoules
cal	calorie	calories
kcal	kilocalorie	kilocalories
Cal	calorie	calories
eV	electron volt	electron volts
keV	kilo-electron volt	kilo-electron volts
MeV	mega-electron volt	mega-electron volts
GeV	giga-electron volt	giga-electron volts
TeV	tera-electron volt	tera-electron volts
kN	kilonewton	kilonewtons
Nm	newton meter	newton meters
Pa	pascal	pascals
hPa	hectopascal	hectopascals
kPa	kilopascal	kilopascals
MPa	megapascal	megapascals
GPa	gigapascal	gigapascals
bar	bar	bar
mbar	millibar	millibars
atm	atmosphere	atmospheres
psi	pound per square inch	pounds per square inch
mmHg	millimeter of mercury	millimeters of mercury
dB	decibel	decibels
rpm	R P M	R P M
bpm	beat per minute	beats per minute
fps	frame per second	frames per second
ppm	part per million	parts per million
ppb	part per billion	parts per billion
mol	mole	moles
mmol	millimole	millimoles
μmol	micromole	micromoles
µmol	micromole	micromoles
px	pixel	pixels
dpi	D P I	D P I
`;
