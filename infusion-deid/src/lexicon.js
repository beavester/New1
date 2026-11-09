/* Infusion De-ID — lexicon
 * Word lists used by the Tier 1-lite name/org/location detector and by the
 * hide-in-plain-sight surrogate generator. Pure data; no PHI.
 * Works in browser (window.DeIDLexicon) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./biglex.js'), require('./dict.js'));
  else root.DeIDLexicon = factory(root.DeIDBigLex || null, root.DeIDDict || null);
})(typeof self !== 'undefined' ? self : this, function (BIG, DICT) {
  'use strict';

  const words = (s) => s.trim().split(/\s+/);
  const setOf = (arr) => new Set(arr.map((w) => w.toLowerCase()));

  // ---------------------------------------------------------------------
  // Common US first names (unambiguous: not also ordinary English words).
  // Mixed eras and origins on purpose — an infusion census is multi-generational.
  // ---------------------------------------------------------------------
  const FIRST_NAMES = words(`
    James John Robert Michael William David Richard Joseph Thomas Charles
    Christopher Daniel Matthew Anthony Donald Steven Paul Andrew Joshua Kenneth
    Kevin Brian George Timothy Ronald Edward Jason Jeffrey Ryan Jacob Gary
    Nicholas Eric Jonathan Stephen Larry Justin Scott Brandon Benjamin Samuel
    Gregory Alexander Patrick Raymond Dennis Jerry Tyler Aaron Jose Adam Nathan
    Henry Douglas Zachary Peter Kyle Noah Ethan Jeremy Walter Christian Keith
    Roger Terry Austin Sean Gerald Carl Harold Dylan Arthur Lawrence Jordan Jesse
    Bryan Billy Bruce Gabriel Joe Logan Alan Juan Albert Willie Elijah Wayne
    Randy Vincent Mason Roy Ralph Bobby Russell Bradley Philip Eugene Louis
    Harry Howard Fred Herbert Leonard Norman Earl Stanley Lloyd Clarence Gordon
    Leroy Floyd Marvin Vernon Bernard Melvin Milton Leon Lester Alvin Clyde
    Cecil Glenn Wallace Elmer Rodney Darrell Francis Dale Lonnie Curtis Ricky
    Dwight Wesley Marcus Darryl Antonio Luis Carlos Miguel Ricardo Pedro Jorge
    Manuel Fernando Francisco Javier Roberto Alejandro Eduardo Raul Ramon Hector
    Rafael Enrique Sergio Oscar Andres Mario Julio Cesar Arturo Ruben Ernesto
    Salvador Gilberto Alfredo Rodrigo Mohammed Ahmed Ali Omar Hassan Ibrahim
    Yusuf Kwame Kofi Chidi Emeka Tariq Rashid Jamal Darnell Tyrone Andre Malik
    Terrence Demetrius Reginald Dominic Angelo Salvatore Vito Giuseppe Dmitri
    Sergei Ivan Nikolai Andrei Viktor Stanislaw Krzysztof Tomasz Piotr Jakub
    Hiroshi Kenji Takeshi Satoshi Yuki Wei Ming Jian Hong Feng Hyun Jin Min
    Seung Nguyen Thanh Minh Tuan Raj Rajesh Vijay Sanjay Amit Arun Suresh Ravi
    Anil Deepak Mohan Krishna Kumar Patel Ahmad Farid Nasser Samir Elias
    Mary Patricia Jennifer Linda Elizabeth Barbara Susan Jessica Sarah Karen
    Nancy Lisa Betty Margaret Sandra Ashley Kimberly Emily Donna Michelle
    Dorothy Carol Amanda Melissa Deborah Stephanie Rebecca Sharon Laura Cynthia
    Kathleen Amy Shirley Angela Helen Anna Brenda Pamela Nicole Emma Samantha
    Katherine Christine Debra Rachel Catherine Carolyn Janet Ruth Maria Heather
    Diane Virginia Julie Joyce Victoria Olivia Kelly Christina Lauren Joan
    Evelyn Judith Megan Cheryl Andrea Hannah Martha Jacqueline Frances Gloria
    Ann Teresa Kathryn Sara Janice Jean Alice Madison Doris Abigail Julia Judy
    Grace Denise Amber Marilyn Beverly Danielle Theresa Sophia Marie Diana
    Brittany Natalie Isabella Charlotte Rose Alexis Kayla Lori Tiffany Mildred
    Edna Ethel Florence Gladys Hazel Irene Lillian Lucille Mabel Myrtle Thelma
    Velma Viola Wilma Bernice Bertha Beulah Eleanor Elsie Estelle Geraldine
    Harriet Henrietta Ida Josephine Loretta Louise Lorraine Marjorie Maxine
    Minnie Norma Opal Pauline Phyllis Rosemary Vera Wanda Yvonne Zelda
    Guadalupe Rosa Carmen Josefina Juana Teresita Lupe Marisol Elena Isabel
    Adriana Alejandra Beatriz Lucia Pilar Soledad Yolanda Fatima Aisha Amina
    Khadija Zainab Layla Nadia Yasmin Imani Aaliyah Ayana Ebony Keisha Latoya
    Tamika Shaniqua Chantal Giovanna Francesca Alessandra Valentina Svetlana
    Natasha Olga Tatiana Irina Ekaterina Agnieszka Malgorzata Katarzyna Yuki
    Sakura Aiko Mei Ling Xiu Hui Yan Ji Soo Eun Priya Anjali Pooja Kavita
    Sunita Lakshmi Deepa Meera Neha Shreya Hana Noor Mariam Sana Leila
    Kaitlyn Brianna Destiny Alyssa Kaylee Makayla Addison Avery Harper Aubrey
    Zoey Lillian Hailey Kennedy Riley Savannah Brooklyn Payton Peyton Taylor
    Morgan Jayden Aiden Caden Landon Carter Hunter Connor Owen Gavin Wyatt
    Liam Lucas Oliver Elliott Sebastian Julian Levi Isaac Asher Theodore Ezra
    Thaddeus Cornelius Reginald Augustus Bartholomew Ignatius Leopold Rupert
    Delphine Ottilie Philippa Rosalind Winifred Clementine Georgiana Honora
    Hope Faith Joy Dawn Autumn Summer April Penny Sandy Ray Rich Rob Frank Grant
    Chance Jack Jay Max Mark Bill Will Sue Pat Art Chase Hunter Lily Iris Ivy
    Daisy Olive Hazel Willow Jasmine Holly Laurel Robin Angel Carmen Dolores
    Mercedes Violet Ruby Pearl Amber Victor Lance Glen Glenn Norman Red Rusty
    Sterling Cliff Clay Gale Storm Major Bell Rose June May Grace Lee Dean Wade
  `);

  // Common US surnames.
  const SURNAMES = words(`
    Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez
    Hernandez Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin
    Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker
    Young Allen King Wright Scott Torres Nguyen Hill Flores Green Adams Nelson
    Baker Hall Rivera Campbell Mitchell Carter Roberts Gomez Phillips Evans
    Turner Diaz Parker Cruz Edwards Collins Reyes Stewart Morris Morales Murphy
    Cook Rogers Gutierrez Ortiz Morgan Cooper Peterson Bailey Reed Kelly Howard
    Ramos Kim Cox Ward Richardson Watson Brooks Chavez Wood James Bennett Gray
    Mendoza Ruiz Hughes Price Alvarez Castillo Sanders Patel Myers Long Ross
    Foster Jimenez Powell Jenkins Perry Russell Sullivan Bell Coleman Butler
    Henderson Barnes Gonzales Fisher Vasquez Simmons Romero Jordan Patterson
    Alexander Hamilton Graham Reynolds Griffin Wallace Moreno West Cole Hayes
    Bryant Herrera Gibson Ellis Tran Medina Aguilar Stevens Murray Ford Castro
    Marshall Owens Harrison Fernandez McDonald Woods Washington Kennedy Wells
    Vargas Henry Chen Freeman Webb Tucker Guzman Burns Crawford Olson Simpson
    Porter Hunter Gordon Mendez Silva Shaw Snyder Mason Dixon Munoz Hunt Hicks
    Holmes Palmer Wagner Black Robertson Boyd Rose Stone Salazar Fox Warren
    Mills Meyer Rice Schmidt Garza Daniels Ferguson Nichols Stephens Soto
    Weaver Ryan Gardner Payne Grant Dunn Kelley Spencer Hawkins Arnold Pierce
    Vazquez Hansen Peters Santos Hart Bradley Knight Elliott Cunningham Duncan
    Armstrong Hudson Carroll Lane Riley Andrews Alvarado Ray Delgado Berry
    Perkins Hoffman Johnston Matthews Pena Richards Contreras Willis Carpenter
    Lawrence Sandoval Guerrero George Chapman Rios Estrada Ortega Watkins
    Greene Nunez Wheeler Valdez Harper Burke Larson Santiago Maldonado Morrison
    Franklin Carlson Austin Dominguez Carr Lawson Jacobs OBrien Lynch Singh
    Vega Bishop Montgomery Oliver Jensen Harvey Williamson Gilbert Dean Sims
    Espinoza Howell Li Wong Reid Hanson Le McCoy Garrett Burton Fuller Wang
    Weber Welch Rojas Lucas Marquez Fields Park Yang Little Banks Padilla Day
    Walsh Bowman Schultz Luna Fowler Mejia Davidson Acosta Brewer May Holland
    Juarez Newman Pearson Curtis Cortez Douglas Schneider Joseph Barrett Navarro
    Figueroa Keller Avila Wade Molina Stanley Hopkins Campos Barnett Bates
    Chambers Caldwell Beck Lambert Miranda Byrd Craig Ayala Lowe Frazier Powers
    Neal Leonard Gregory Carrillo Sutton Fleming Rhodes Shelton Schwartz Norris
    Jennings Watts Duran Walters Cohen McDaniel Moran Parks Steele Vaughn Becker
    Holt DeLeon Barker Terry Hale Leon Hail Benson Haynes Horton Miles Lyons
    Pham Graves Bush Thornton Wolfe Warner Cabrera McKinney Mann Zimmerman Dawson
    Lara Fletcher Page McCarthy Love Robles Cervantes Solis Erickson Reeves
    Chang Klein Salinas Fuentes Baldwin Daniel Simon Velasquez Hardy Higgins
    Aguirre Lin Cummings Chandler Sharp Barber Bowen Ochoa Dennis Robbins
    Rodgers Blake Kaur Dang Huynh Vu Hoang Phan Bui Do Ly Truong Ng Chan Cheung
    Lam Leung Wu Zhang Liu Zhao Huang Zhou Xu Sun Ma Zhu Hu Guo He Gao Lin Luo
    Kumar Sharma Shah Gupta Mehta Reddy Rao Nair Iyer Desai Joshi Malhotra
    Kapoor Chaudhry Khan Hussain Ahmed Ali Malik Siddiqui Qureshi Farooq Rahman
    Okafor Okoro Nwosu Adeyemi Oyelaran Mensah Boateng Abebe Tesfaye Haile
    Kowalski Nowak Wisniewski Wojcik Kaminski Lewandowski Zielinski Szymanski
    Novak Horvat Petrov Ivanov Smirnov Kuznetsov Popov Volkov Sokolov Rossi
    Russo Ferrari Esposito Bianchi Romano Colombo Ricci Marino Greco Bruno
    Mueller Schulz Fischer Meier Wagner Becker Hoffmann Koch Richter Wolf
    Dubois Moreau Laurent Lefebvre Bernard Petit Durand Leroy Fontaine
    OConnor OReilly Murphy Kelly Byrne Doyle McCarthy Gallagher Fitzgerald
    Goldberg Friedman Rosenberg Katz Levine Shapiro Weinstein Feldman Kaplan
    Beaver Whitaker Pendleton Ashcroft Thistlewood Castellano Delacroix Fairweather
  `);

  // ---------------------------------------------------------------------
  // Names that are also ordinary words, months, drugs, or clinical terms.
  // These need a cue (honorific, relation word, adjacent name) before we tag them.
  // ---------------------------------------------------------------------
  const AMBIGUOUS = setOf(words(`
    Grace Bell May June Rose Hope Faith Joy Dawn Autumn Summer April Carol
    Penny Sandy Ray Rich Rob Frank Grant Chance Jack Jay Max Mark Bill Will
    Sue Pat Art Chase Hunter Hail Lane Park Day Love Page Sharp Little Long
    Young Black White Green Brown Gray Stone Wood Woods Hill Hall King Price
    Rice Fox Wolf Wolfe Bush Fields Banks Lake Rivers Brooks Shore Ford Lee
    Dean Holland Simon Daniel Thomas James George Henry Lewis Allen Scott
    Warren Wells West Cole Burns Mills Reed Marsh Gale Storm Cliff Clay Sterling
    Victor Major Glen Glenn Norman Lance Rusty Red Ruby Pearl Amber Violet
    Lily Iris Ivy Daisy Olive Hazel Willow Jasmine Heather Holly Laurel Fern
    Robin Wren Raven Lark Dove Martin Sparrow Bishop Knight Dixon Mason Cook
    Baker Carter Porter Hunt Ward Wright Carpenter Shepherd Taylor Weaver
    Miller Fisher Barber Butler Brewer Gardner Turner Marshall Steele Sims
    Welch Bowman Fowler Barker Hardy Dennis Terry Curtis Joseph Leon Miles
    Hale Rhodes Powers Stanley Barrett Baldwin Bates Beck Wade Lowe Love Neal
    Hamilton Jordan Austin Lincoln Madison Jackson Kennedy Washington Franklin
    Morgan Riley Taylor Avery Harper Kelly Shelton Chambers Holt Walters
    Cross Church Bridges Hollow Dale Vale Grove Field Forest Meadow
    Angel Christian Noel Carmen Dolores Mercedes Concepcion Rosario Trinidad
    Hong Ming Wei Jin Min Hu He Ma Do Ng Le Ly Li Lin Sun Ko Yu An Ha Ho So
  `));

  // ---------------------------------------------------------------------
  // Clinical eponyms, drug names, and terms that look like names but must
  // never be redacted. Oncology-heavy by design.
  // ---------------------------------------------------------------------
  const CLINICAL_ALLOWLIST = setOf(words(`
    Hodgkin Hodgkins Hodgkin's Ewing Ewing's Wilms Wilms' Burkitt Burkitt's
    Kaposi Kaposi's Waldenstrom Waldenström Richter Richter's Merkel Barrett
    Barrett's Paget Paget's Cushing Cushing's Addison Addison's Crohn Crohn's
    Graves Graves' Bell Bell's Parkinson Parkinson's Alzheimer Alzheimer's
    Kussmaul Raynaud Raynaud's Sjogren Sjögren Sjogren's Hashimoto Hashimoto's
    Down Downs Down's Turner Turner's Klinefelter Marfan Ehlers Danlos Hunter
    Hurler Gaucher Fabry Pompe Tay Sachs Huntington Huntington's Wilson Wilson's
    Lynch Li Fraumeni Peutz Jeghers Cowden Gardner Gardner's Fanconi Bloom
    Nijmegen Rothmund Werner Stevens Johnson Lyell Guillain Barre Barré
    Horner Horner's Pancoast Virchow Trousseau Courvoisier Murphy Murphy's
    McBurney Rovsing Kehr Cullen Grey Homan Homans Babinski Brudzinski Kernig
    Osler Weber Rendu Janeway Roth Reed Sternberg Auer Howell Jolly Heinz
    Dohle Pelger Huet Chediak Higashi Mallory Weiss Zollinger Ellison
    Whipple Whipple's Meckel Hirschsprung Barlow Ortolani Legg Calve Perthes
    Osgood Schlatter Dupuytren Colles Monteggia Galeazzi Lisfranc Jones
    Bankart Hill Sachs Gleason Nottingham Bloom-Richardson Breslow Clark
    Ann Arbor Lugano Deauville Cheson RECIST Lansky Karnofsky ECOG Charlson
    Glasgow Apgar Braden Morse Wells Geneva Child Pugh MELD Ranson Alvarado
    Keytruda Opdivo Tecentriq Imfinzi Yervoy Herceptin Perjeta Kadcyla Enhertu
    Avastin Erbitux Vectibix Rituxan Truxima Ruxience Gazyva Darzalex Sarclisa
    Kyprolis Velcade Ninlaro Revlimid Pomalyst Thalomid Imbruvica Calquence
    Brukinsa Venclexta Ibrance Kisqali Verzenio Lynparza Zejula Rubraca Talzenna
    Tagrisso Tarceva Iressa Gilotrif Alecensa Xalkori Zykadia Alunbrig Lorbrena
    Tabrecta Tepmetko Retevmo Gavreto Lumakras Krazati Rozlytrek Vitrakvi
    Adcetris Polivy Padcev Trodelvy Blenrep Zynlonta Tivdak Elahere Lunsumio
    Columvi Epkinly Talvey Tecvayli Elrexfio Carvykti Abecma Yescarta Kymriah
    Breyanzi Tecartus Neulasta Neupogen Zarxio Udenyca Fulphila Nyvepria
    Ziextenzo Fylnetra Granix Leukine Procrit Epogen Aranesp Retacrit Zofran
    Aloxi Emend Cinvanti Akynzeo Varubi Sancuso Sustol Decadron Benadryl
    Pepcid Tylenol Ativan Compazine Reglan Zyprexa Xgeva Prolia Zometa Aredia
    Taxol Taxotere Abraxane Jevtana Halaven Ixempra Navelbine Oncovin Velban
    Adriamycin Doxil Ellence Idamycin Cerubidine Mitomycin Bleo Blenoxane
    Platinol Paraplatin Eloxatin Cytoxan Ifex Mesnex Treanda Bendeka Belrapzo
    Alimta Pemfexy Fludara Leustatin Nipent Clolar Arranon Xeloda Adrucil
    Camptosar Onivyde Hycamtin Vepesid Toposar Etopophos Gemzar Infugem
    Lupron Eligard Zoladex Firmagon Trelstar Faslodex Arimidex Femara Aromasin
    Nolvadex Soltamox Zytiga Xtandi Erleada Nubeqa Casodex Pluvicto Xofigo
    Lutathera Azedra Sandostatin Somatuline Afinitor Sutent Nexavar Votrient
    Inlyta Cabometyx Lenvima Stivarga Fotivda Welireg Jakafi Inrebic Vonjo
    Ojjaara Sprycel Tasigna Bosulif Iclusig Scemblix Gleevec Hydrea Droxia
    Vidaza Onureg Dacogen Inqovi Venetoclax Idhifa Tibsovo Rezlidhia Xospata
    Vanflyta Rydapt Mylotarg Besponsa Blincyto Vyxeos Oncaspar Asparlas Rylaze
    Erwinaze Purixan Trexall Otrexup Rasuvo Xatmep Elitek Fasturtec Kepivance
    Ethyol Totect Zinecard Savene Mesna Leucovorin Fusilev Khapzory Voraxaze
    Heparin Lovenox Fragmin Arixtra Eliquis Xarelto Pradaxa Coumadin Jantoven
    Plavix Brilinta Effient Aspirin Lipitor Crestor Zocor Pravachol Lasix
    Bumex Aldactone Norvasc Cardizem Lopressor Toprol Coreg Zestril Prinivil
    Vasotec Cozaar Diovan Benicar Micardis Avapro Entresto Lanoxin Cordarone
    Multaq Synthroid Levoxyl Unithroid Armour Cytomel Metformin Glucophage
    Januvia Jardiance Farxiga Invokana Ozempic Trulicity Victoza Lantus Levemir
    Humalog Novolog Tresiba Basaglar Toujeo Prilosec Nexium Protonix Prevacid
    Zantac Carafate Miralax Colace Senokot Dulcolax Imodium Lomotil Flagyl
    Cipro Levaquin Avelox Zithromax Biaxin Augmentin Keflex Bactrim Septra
    Macrobid Diflucan Vfend Noxafil Cresemba Mycamine Cancidas Eraxis Valtrex
    Zovirax Famvir Tamiflu Paxlovid Veklury Prednisone Medrol Solu-Medrol
    Solu-Cortef Kenalog Depo-Medrol Celestone Florinef Dexamethasone Dexa Decadron
    Demerol Meperidine Cimzia Dilaudid Hydromorphone Toradol Ketorolac Phenergan Promethazine Narcan Naloxone Vyvgart Rystiggo Ilaris Kineret Skyrizi Omvoh Tremfya Cosentyx Taltz Humira Enbrel Claritin Zyrtec
    Port Port-a-Cath Portacath PICC Hickman Groshong Broviac Huber PowerPort
    Mediport Infusaport BardPort Smart Port Vortex Xcela Dignity Titanium
    Epic Hyperspace Beacon Cadence Prelude Haiku Canto
    Rover Cupid Radiant Kaleidoscope Bugsy Optime Stork Wisdom Tapestry
    Cerner Meditech Allscripts Athena NextGen eClinicalWorks CareCloud
    Monday Tuesday Wednesday Thursday Friday Saturday Sunday Mon Tue Tues Wed
    Thu Thur Thurs Fri Sat Sun January February March April May June July
    August September October November December Jan Feb Mar Apr Jun Jul Aug
    Sep Sept Oct Nov Dec AM PM EST EDT CST CDT MST MDT PST PDT
    Chair Bay Room Pod Suite Infusion Chemo Oncology Hematology Radiation
    Pharmacy Lab Labs CBC CMP BMP LFT INR PT PTT ANC Hgb Hct Plt WBC RBC MCV
    Cr BUN eGFR AST ALT Alk Phos Bili Alb Mg Phos Ca K Na Cl CO2 Glu TSH
    Tumor Marker CEA CA PSA AFP LDH Beta HCG BRCA HER2 ER PR Ki67 PDL1 MSI
    CT MRI PET PETCT EKG ECG ED ER ICU OR PACU IR GI GU ENT OB OBGYN OT SLP
    SNF LTC ALF DME IV IM SC SQ PO PRN BID TID QID QD NPO LVM VM VMS TC HC
    NS RL D5 D5W KCL MGSO4 TPN PCA PICC CVC CVAD IVF ABX ABG VS BP HR RR TPA
    Cathflo Alteplase Activase Onpro Huber Beacon Hyperspace MyChart Haiku
    Calvert Cockcroft Gault Mosteller Jelliffe Chatelut Haycock Egorin Kelman
    Carbo Cisplat Cis Oxali Gem Vinc Dox Adria Cytox Bleo Iri Irino Topo Etop Pacli Doce Pem Lenal Bortez Dara Ritux Obin
    Bren Niv Pembro Ipi Atezo Durva Avel Cemi Tras Pertuz Cetux Pani Decad Benadryl Zofran Ativan Pepcid
    Darzalex Faspro Tepezza Xolair Lemtrada Herzuma Ogivri Kanjinti Trazimera Ontruzant Phesgo Hylecta Hycela Mvasi Zirabev
    Alymsys Vegzelma Riabni Truxima Ruxience Ocrevus Briumvi Kesimpta Tysabri Entyvio Stelara Remicade Inflectra Renflexis
    Avsola Simponi Actemra Orencia Benlysta Saphnelo Krystexxa Soliris Ultomiris Uplizna Enspryng Vyepti Evenity Leqembi
    Kisunla Aduhelm Nplate Promacta Reblozyl Adakveo Oxbryta Gamunex Privigen Octagam Gammagard Hizentra Cuvitru Xembify
    Panzyga Bivigam Flebogamma Asceniv Gammaplex Cinryze Berinert Haegarda Takhzyro Fasenra Nucala Dupixent Tezspire Cinqair
    Rituxan Gazyva Arzerra Kyprolis Empliciti Sarclisa Talvey Tecvayli Elrexfio Columvi Epkinly Lunsumio Blincyto Besponsa
    Mylotarg Vyxeos Onureg Inqovi Adcetris Polivy Padcev Trodelvy Enhertu Kadcyla Datroway Elahere Tivdak Zynlonta Blenrep
    Imjudo Jemperli Zynyz Loqtorzi Tevimbra Opdualag Libtayo Bavencio Imfinzi Tecentriq Opdivo Keytruda Yervoy Kimmtrak
    Lumoxiti Poteligeo Unituxin Danyelza Rybrevant Lumakras Portrazza Cyramza Zaltrap Vectibix Erbitux Avastin Herceptin
    Perjeta Abraxane Halaven Ixempra Jevtana Navelbine Doxil Onivyde Zepzelca Cosela Trilaciclib Aliqopa Folotyn Beleodaq
    Istodax Velcade Treanda Bendeka Belrapzo Vivimusta Marqibo Erwinase Rylaze Oncaspar Asparlas Elzonris Pluvicto Lutathera
    Xofigo Zoladex Lupron Eligard Firmagon Trelstar Camcevi Faslodex Sandostatin Somatuline Signifor Fensolvi Supprelin
    Feraheme Injectafer Venofer Monoferric Infed Ferrlecit Retacrit Aranesp Procrit Epogen Mircera Udenyca Ziextenzo Fulphila
    Nyvepria Fylnetra Stimufend Rolvedon Ryzneuta Neupogen Zarxio Nivestym Releuko Granix Leukine Mozobil Aphexda Nulibry
    Methylpred Methylprednisolone Solumedrol Solucortef Hydrocortisone Famotidine Diphenhydramine Acetaminophen Cetirizine
    Fosaprepitant Aprepitant Palonosetron Granisetron Ondansetron Olanzapine Prochlorperazine Lorazepam Dexamethasone
    CIDP MMN NMO NMOSD RRMS SPMS PPMS ITP TTP AIHA PNH aHUS HAE CVID SLE PsA GCA PMR AAV GPA EGPA ALS SMA DMD HSCT BMT GVHD
    CRS ICANS TLS DIC HIT VTE IgG IgA IgM IgE IgG4 Quervain
    Mesna Leucovorin Levoleucovorin Fusilev Khapzory Amifostine Dexrazoxane Totect Zinecard Glucarpidase Voraxaze Rasburicase
    HOH NKDA NKA NKFA DNR DNI MOLST POLST PMH PSH FHx SHx ROS HPI SOB CHF COPD CAD HTN CKD ESRD GERD OSA AFib CVA TIA DVT BPH SLE
    HLD DM2 T2DM IDDM NIDDM PNA AKI ARF UTI URI BM GI GU HEENT MSK CNS PNS PVD PAD AAA CABG PCI PTCA ICD PPM LVAD
    EGFR ALK ROS1 KRAS NRAS BRAF MET RET NTRK FGFR IDH FLT3 NPM1 TP53 BCR ABL
    JAK STAT PIK3CA PTEN RB1 CDK CDKN2A MYC BCL2 BCL6 CD19 CD20 CD30 CD33 CD38
    BCMA GPRC5D FcRH5 CTLA PD1 PD-L1 VEGF PDGF TKI PARP ADC CAR-T BiTE IO
    Neutropenia Thrombocytopenia Anemia Mucositis Neuropathy Nausea Emesis
    Fatigue Fever Rigors Chills Rash Pruritus Diarrhea Constipation Dyspnea
    Cycle Day Dose Premed Premeds Prehydration Hydration Bolus Push Drip
    Flush Saline Dextrose Lactated Ringers Ringer's Normal Half Quarter
    Grade Stage Line Arm Regimen Protocol Study Trial Cohort Screening
    Consent Pending Approved Denied Hold Held Holding Resume Resumed Delay
    Delayed Reschedule Rescheduled Cancel Cancelled Canceled Completed Done
    Will Call Called Calling Pt Pts Patient Patients Family Spouse Caregiver
    Son Daughter Wife Husband Mother Father Brother Sister Grandson Granddaughter
    North South East West Main Central Upper Lower Inner Outer Old New
    ABVD BEACOPP CHOP R-CHOP EPOCH DA-EPOCH ICE DHAP ESHAP GDP GemOx BR
    FOLFOX FOLFIRI FOLFOXIRI FOLFIRINOX CAPOX XELOX XELIRI AC TC TCH TCHP
    ddAC EC FEC CMF CAF TAC ACT AC-T PCb EP EC-T VIP BEP TIP VeIP R-CVP CVP
    CyBorD VRd KRd DRd DVd DPd DKd IRd Rd Vd VCD VTD MPT MPV VMP
    HyperCVAD CALGB COG AALL ECOG SWOG NRG NSABP RTOG GOG NCCN ASCO ASH ESMO
    MAID AIM VAC VDC IE VDC/IE VIDE VAI OPEC CEV ICE/VAC
    PCP SW MSW CSW RT EMS DNR DNI MOLST POLST HCP POA MPOA DPOA ADL IADL PMH PSH
    FH SH ROS HPI HEENT CV RESP ABD EXT NEURO PSYCH MSK LVM VM FU RTC DC DX TX HX
    SX RX OTC QOL AE SAE DLT MTD ORR PFS OS CR SD PD NED SUV FDG IVC SVC DVT PE CVA
    TIA MI CHF COPD CKD ESRD HTN DM DM2 GERD OSA CAD AFIB UTI URI MRSA VRE HIV HCV
    HBV CMV EBV HPV TB PNA ARDS AKI SIRS DIC TLS CRS ICANS GVHD HSCT BMT SCT PBSC
    ASCT NSCLC SCLC HCC RCC CRC TNBC DCIS LCIS IDC ILC GBM AML ALL CLL CML MDS MM
    MGUS DLBCL FL MCL MZL PTCL CTCL WM HL NHL GIST NET SCC BCC PNET SBRT IMRT XRT
    SRS EBRT AUC BSA Wt Ht Temp SpO2 RA ANC WBC BID TID QID NPO BP HR RR
    Vomiting Cough Pain Weakness Dizziness Headache Swelling Bleeding Bruising
    Infection Sepsis Hypotension Hypertension Tachycardia Dehydration Hyponatremia
    Hypokalemia Hypomagnesemia Hyperglycemia Hypoglycemia Edema Erythema Flushing
    Itching Numbness Tingling Tolerated Discharged Ambulatory Precautions Given
    Reviewed Verified Confirmed Noted Signed Entered Updated Scheduled Arrived
    Teaching Education Consent Verbalized Understanding Tolerating Stable Improved
    Worsening Unchanged Resolved Ongoing Controlled Uncontrolled Mild Moderate Severe
    Carboplatin Cisplatin Oxaliplatin Paclitaxel Docetaxel Gemcitabine Irinotecan
    Fluorouracil Capecitabine Pemetrexed Etoposide Doxorubicin Cyclophosphamide
    Vincristine Rituximab Trastuzumab Pertuzumab Bevacizumab Pembrolizumab Nivolumab
    Atezolizumab Durvalumab Ipilimumab Cetuximab Panitumumab Daratumumab Bortezomib
    Carfilzomib Lenalidomide Dexamethasone Ondansetron Palonosetron Fosaprepitant
    Diphenhydramine Famotidine Acetaminophen Lorazepam Prochlorperazine Metoclopramide
    Epi EpiPen
    Methotrexate Leucovorin Bendamustine Azacitidine Decitabine Venetoclax Zoledronic
    Denosumab Filgrastim Pegfilgrastim Epoetin Darbepoetin Ferumoxytol Venofer Injectafer
    Feraheme Infed Monoferric Ocrevus Entyvio Remicade Inflectra Renflexis Avsola Stelara
    Tysabri Actemra Orencia Benlysta Soliris Ultomiris Krystexxa Reclast Evenity IVIG
    Gammagard Gamunex Privigen Octagam Alaris Baxter Plum Sapphire Smiths Medfusion CADD
    Walgreens CVS Rite Wegmans Tops Kroger Costco Walmart Quest LabCorp Medicare Medicaid
    MRN DOB Acct CSN HAR FIN SSN MBI HICN NPI DEA Uber Lyft NEXUS
  `));
  // After one of these words an eponym that is also a surname stays clinical (Grey Turner sign, Cullen sign, Babinski reflex).
  const EPONYM_FOLLOW = setOf(words(`sign signs syndrome disease test reflex palsy lymphoma tumor tumour sarcoma phenomenon maneuver manoeuvre
    voice therapy program programme method technique protocol procedure approach regimen scale score index formula equation classification
    triad node nodes fracture point criteria score scale classification staging stage curve period turner arbor garden geranium lodge`));
  // Well-known regional employers, facilities and chains that identify a patient's workplace or residence when named.
  const LOCAL_ORGS = words(`Moog GEICO Elderwood Sumitomo Praxair Linde Delaware|North Rich|Products Tops Wegmans Kaleida Catholic|Health
    Erie|County|Medical|Center ECMC Roswell Brothers|of|Mercy Canterbury|Woods Weinberg|Campus Amberleigh Beechwood Terrace|View
    Schofield Father|Baker Absolut Hospice|Buffalo Mercy|Flight McGuire|Group Garden|Gate Harris|Hill Autumn|View Ellicott|Center`).map((s) => s.replace(/\|/g, ' '));
  const LOCAL_ORG_SET = setOf(LOCAL_ORGS);

  // Relationship words that signal a third-party name follows or precedes.
  const RELATION_CUES = words(`
    son daughter wife husband spouse partner mother father mom dad mum
    sister brother grandson granddaughter grandmother grandfather grandma
    grandpa aunt uncle niece nephew cousin friend neighbor neighbour caregiver
    caretaker poa proxy guardian fiance fiancee fiancé fiancée boyfriend
    girlfriend roommate companion driver sitter aide nurse navigator
    coordinator pharmacist dietitian chaplain stepson stepdaughter stepmother
    stepfather godmother godfather pastor
    dtr dghtr dau hus husb bro sis gma gpa gson gdaughter granddtr kin nok
    contact caller interpreter translator clerk scheduler visitor therapist
    counselor volunteer attorney lawyer executor hcp mpoa dpoa
    son-in-law daughter-in-law mother-in-law father-in-law sister-in-law brother-in-law
    stepbrother stepsister grandchild twin fiancé fiancee ex-wife ex-husband
    mgr manager navigator worker financial scheduler coordinator chaplain imam rabbi
    reverend deacon priest minister pastor coach boss supervisor coworker colleague
    employer landlord tenant neighbour roomate housemate caregiver aide companion
  `);

  // Greetings and sign-offs that open or close a message ("Hello, ...", "Bonjour, ...", "Thanks, ..."): never a surname; the
  // words after them are the writer introducing themself or the person addressed.
  // (Best, Love and Morning are also surnames, so they are not on this list)
  const GREETINGS = words(`hi hello hey hiya howdy greetings dear bonjour bonsoir salut hola ciao hallo namaste salaam shalom aloha
    thanks thank thx cheers regards sincerely gracias merci obrigado obrigada danke grazie`);
  // Languages and nationalities: "prefers French interpreter", "Interpreter (Spanish)", "Haitian Creole" are never a person,
  // though several are also surnames (French, English, Welsh, Irish)
  const LANGUAGES = words(`english spanish french creole haitian portuguese italian german dutch polish russian ukrainian
    arabic hebrew farsi persian dari pashto urdu hindi bengali bangla punjabi gujarati tamil telugu marathi nepali
    chinese mandarin cantonese taiwanese vietnamese korean japanese tagalog filipino thai lao laotian khmer cambodian burmese
    hmong somali swahili amharic tigrinya oromo yoruba igbo hausa twi wolof greek turkish albanian serbian croatian bosnian
    romanian bulgarian hungarian czech slovak lithuanian latvian estonian finnish swedish norwegian danish icelandic irish
    welsh scottish gaelic american canadian mexican cuban dominican puerto rican guatemalan salvadoran honduran colombian
    venezuelan peruvian ecuadorian brazilian jamaican nigerian ghanaian ethiopian eritrean kenyan sudanese egyptian moroccan
    lebanese syrian iraqi iranian afghan pakistani indian bangladeshi sri lankan asl sign`);
  const HONORIFICS = words(`Dr Dr. Doctor Mr Mr. Mrs Mrs. Ms Ms. Miss Mx Mx. Nurse Prof Prof. Rev Rev. Fr Fr. Sr Sr.`);
  const CREDENTIALS = words(`MD DO NP PA PA-C RN LPN BSN MSN DNP APRN CRNP CNP ARNP PharmD RPh CPhT MSW LCSW RD RDN PhD PsyD DDS DMD DPM FNP ANP AGNP ACNP PMHNP CNM CNS`);

  const ORG_SUFFIXES = words(`
    Hospital Hospitals Medical Center Cancer Center Clinic Clinics Health
    Healthcare Oncology Hematology Associates Institute Memorial Regional
    General University Hospice Pharmacy Infusion Imaging Radiology Labs
    Laboratory Laboratories Physicians Group Partners Specialists Center Centre
    Network System Foundation Care Urgent Surgical Surgery Practice
    Veterans Children's Childrens Women's Womens Rehab Rehabilitation Dialysis
    Nursing Manor Village Senior Living Assisted Urology Cardiology
    Neurology Neurologic Gastroenterology Dermatology Orthopedics Orthopedic
    Community County Regional Memorial Home Agency Association Services
    Township Parish SNF ALF LTC Insurance BCBS Inc LLC Corp Corporation Company Ltd
    Hosp Ctr Inst Assoc Med Onc Heme Surg Ortho Derm Neuro Peds Pulm Urol Gyn
    Industries Motors Transport Transportation Ambulance EMS Funeral
    Church Chapel Mosque Masjid Temple Synagogue Shul Ministries Congregation Cathedral
    Products Foods Bank Credit Union Mall Market Plaza Apartments Towers
  `);
  // Words that take the NEXT capitalized token as the specific part (Masjid An-Noor, Camp Good Days, Hotel Lafayette).
  const ORG_PREFIXES = words(`Masjid Mosque Temple Church Chapel Synagogue Camp Hotel Hospice Villa Casa`);
  // Suffix words that make the whole phrase a geographic unit rather than an organization.
  const GEO_SUFFIXES = words(`County Township Parish`);
  // Words that frequently *name* a facility (not generic): they count as the specific part.
  const ORG_NAMEWORDS = words(`
    Mercy Sinai Presbyterian Methodist Baptist Lutheran Adventist Providence
    Samaritan Trinity Ascension Sisters Charity Saint Kaiser Mayo Hamot
    Roswell Wilmot Strong Oishei Kaleida Catholic Jewish Christian Episcopal
    Mount Mt Holy Sacred Heart Good Shepherd Cross Grace Hope Faith Unity
  `);

  const US_STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
    KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
    MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
    NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
    OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
    VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    DC: 'District of Columbia',
  };

  const US_CITIES = words(`
    Buffalo Rochester Syracuse Albany Yonkers Brooklyn Queens Bronx Manhattan
    Amherst Cheektowaga Tonawanda Niagara Lackawanna Hamburg Orchard Lockport
    Batavia Jamestown Olean Dunkirk Erie Cleveland Pittsburgh Columbus Toledo
    Akron Dayton Cincinnati Detroit Chicago Milwaukee Minneapolis Boston
    Worcester Springfield Hartford Providence Philadelphia Newark Baltimore
    Richmond Charlotte Raleigh Atlanta Jacksonville Orlando Tampa Miami
    Nashville Memphis Louisville Indianapolis Kansas Omaha Denver Phoenix
    Tucson Albuquerque Dallas Houston Austin Antonio Oklahoma Tulsa Seattle
    Portland Sacramento Francisco Oakland Jose Angeles Diego Vegas Honolulu
    Anchorage Birmingham Montgomery Mobile Jackson Orleans Rouge Little Rock
    Des Moines Wichita Topeka Lincoln Fargo Sioux Billings Boise Salt Reno
    Cheyenne Madison Lansing Grand Rapids Fort Wayne Toronto Hamilton Fort Erie
    Welland Catharines Mississauga Ottawa Montreal Scranton Allentown Harrisburg
    Ithaca Binghamton Elmira Utica Schenectady Troy Poughkeepsie Newburgh
    Kingston Plattsburgh Watertown Oswego Auburn Geneva Canandaigua Corning
    Falls Springs Beach Heights Park City Town Valley
    Williamsville Clarence Lancaster Depew Kenmore Lewiston Wheatfield Sanborn
    Springville Angola Gowanda Salamanca Fredonia Westfield Attica Geneseo
    Medina Albion Brockport Irondequoit Penfield Webster Fairport Pittsford
    Henrietta Hornell Wellsville Bradford Meadville Blasdell Getzville Snyder
    Eggertsville Aurora Seneca Lakewood Fairview Riverside Lakeside Hillside
  `);
  // Directional/compound prefixes that start a two-word place name (East Aurora, North Tonawanda, Fort Erie).
  const PLACE_PREFIXES = words(`North South East West New Fort Ft Mount Mt Lake Port Saint St San Los Las Grand Upper Lower Cape Santa Little Big`);

  // Hold-out names: deliberately NOT in FIRST_NAMES/SURNAMES. The synthetic
  // stress set uses these for a share of third-party names so recall on
  // out-of-lexicon names is measured honestly.
  const HOLDOUT_FIRST = words(`
    Oluwaseun Keziah Thandiwe Siobhan Eamonn Anneliese Bartek Ngozi Rutger
    Xiomara Yevgenia Tobias Marguerite Desmond Priyanka Lorcan Ingrid Baptiste
    Zuleika Caoimhe Oisin Ferdinand Wilhelmina Esperanza Jedidiah Temperance
    Leocadia Anselm Cressida Phineas Evangelina Barnaby Dorotea Lucinda Osric
    Mireille Tadeo Giselle Hamish Perpetua Casimir Isadora Ludovic Seraphina
    Vashti Zebediah Ottoline Lysander Fenella Ambrose Rosalba Ignacia Thorsten
  `);
  const HOLDOUT_LAST = words(`
    Abernathy Vanterpool Okonkwo Szczepanski Featherstone Delacruz-Ortiz
    Kirchhoff Ramasubramanian Whitlock Oyelowo Fairbanks Nakashima Thibodeaux
    Brannigan Vasilenko Ostrowski Hightower Mbeki Castellanos Lindqvist
    Quintanilla Pemberton Achterberg Tremblay Okunade Birkenstock Vandermeer
    Greenblatt Haverford Ikemefuna Sallinen Dubrovsky Montalban Yarbrough
    Kuzmenko Falconer Strickland Nwachukwu Eriksdottir Villanueva Papadakis
    Brightwater Holmquist Zapatero Lindgren Marchetti Sowerby Traynor
  `);

  // Diminutives and short forms that a census first name may appear as in free text (English, Spanish, Polish, Italian,
  // Vietnamese and Arabic conventions). Lower-case formal name -> list of forms. Reverse forms are derived at load.
  const NICKNAMES = {
    benjamin: ['Ben', 'Benny', 'Benji', 'Benjie'], william: ['Bill', 'Billy', 'Will', 'Willy', 'Liam'], robert: ['Rob', 'Bob', 'Bobby', 'Robbie', 'Bert'],
    richard: ['Rick', 'Ricky', 'Dick', 'Rich', 'Richie'], james: ['Jim', 'Jimmy', 'Jamie'], john: ['Jack', 'Johnny', 'Jon'], joseph: ['Joe', 'Joey', 'Jos'],
    michael: ['Mike', 'Mikey', 'Mick'], thomas: ['Tom', 'Tommy'], charles: ['Charlie', 'Chuck', 'Chas'], christopher: ['Chris', 'Kit', 'Topher'],
    daniel: ['Dan', 'Danny'], matthew: ['Matt', 'Matty'], anthony: ['Tony', 'Ant'], donald: ['Don', 'Donny'], steven: ['Steve', 'Stevie'],
    stephen: ['Steve', 'Stevie'], paul: ['Paulie'], andrew: ['Andy', 'Drew'], joshua: ['Josh'], kenneth: ['Ken', 'Kenny'], kevin: ['Kev'],
    brian: ['Bri'], george: ['Georgie'], timothy: ['Tim', 'Timmy'], ronald: ['Ron', 'Ronnie'], edward: ['Ed', 'Eddie', 'Ted', 'Teddy', 'Ned'],
    jeffrey: ['Jeff'], jeffery: ['Jeff'], jacob: ['Jake'], nicholas: ['Nick', 'Nicky'], jonathan: ['Jon', 'Jonny'], lawrence: ['Larry'],
    gregory: ['Greg'], alexander: ['Alex', 'Al', 'Sasha', 'Xander'], patrick: ['Pat', 'Paddy', 'Patty'], raymond: ['Ray'], dennis: ['Denny'],
    gerald: ['Gerry', 'Jerry'], samuel: ['Sam', 'Sammy'], nathan: ['Nate'], henry: ['Hank', 'Harry'], douglas: ['Doug'], zachary: ['Zach', 'Zack'],
    peter: ['Pete'], walter: ['Walt', 'Wally'], leonard: ['Len', 'Lenny', 'Leo'], harold: ['Hal', 'Harry'], arthur: ['Art', 'Artie'],
    albert: ['Al', 'Bert', 'Bertie'], eugene: ['Gene'], louis: ['Lou', 'Louie'], frederick: ['Fred', 'Freddie', 'Freddy'], herbert: ['Herb', 'Herbie'],
    norman: ['Norm'], stanley: ['Stan'], vincent: ['Vince', 'Vinny'], russell: ['Russ', 'Rusty'], philip: ['Phil'], phillip: ['Phil'],
    bernard: ['Bernie'], melvin: ['Mel'], lester: ['Les'], alvin: ['Al'], wallace: ['Wally'], francis: ['Frank', 'Frankie'], theodore: ['Ted', 'Teddy', 'Theo'],
    salvatore: ['Sal', 'Sally', 'Tore'], giuseppe: ['Beppe', 'Peppe', 'Joe'], vito: ['Vit'], angelo: ['Ang'], dominic: ['Dom', 'Nick'],
    francisco: ['Paco', 'Pancho', 'Frank'], jose: ['Pepe', 'Joe'], manuel: ['Manny', 'Manolo'], ignacio: ['Nacho'], guillermo: ['Memo'],
    enrique: ['Quique', 'Kike'], alejandro: ['Alex', 'Ale'], eduardo: ['Lalo', 'Eddie'], roberto: ['Beto', 'Rob'], ricardo: ['Ricky', 'Richie'],
    antonio: ['Tony', 'Toño'], jesus: ['Chuy'], rafael: ['Rafa'], javier: ['Javi'], santiago: ['Santi'], sergio: ['Checo'], fernando: ['Fer', 'Nando'],
    krzysztof: ['Krzysiek', 'Krys', 'Chris'], stanislaw: ['Stas', 'Stan', 'Stasiek'], tomasz: ['Tomek', 'Tom'], piotr: ['Piotrek', 'Peter'],
    jakub: ['Kuba'], grzegorz: ['Grzesiek', 'Grzes', 'Greg'], wojciech: ['Wojtek'], andrzej: ['Andrzejek', 'Andrew'], bartosz: ['Bartek'], bartlomiej: ['Bartek'],
    mohammed: ['Mo', 'Mohd', 'Hamid'], mohammad: ['Mo', 'Mohd'], muhammad: ['Mo', 'Mohd'], abdullah: ['Abdul'], ibrahim: ['Ibi'], hassan: ['Hass'],
    nguyen: ['Nguyen'], thanh: ['Thanh'], dmitri: ['Dima', 'Mitya'], sergei: ['Seryozha'], nikolai: ['Kolya', 'Nick'], andrei: ['Andryusha'],
    viktor: ['Vitya', 'Vic'], ivan: ['Vanya'], hiroshi: ['Hiro'], takeshi: ['Take'], satoshi: ['Sato'], rajesh: ['Raj'], sanjay: ['Sanj'], vijay: ['Vij'],
    elizabeth: ['Liz', 'Beth', 'Betty', 'Lizzie', 'Eliza', 'Betsy', 'Libby', 'Lisa'], katherine: ['Kate', 'Katie', 'Kathy', 'Kat', 'Kay'], catherine: ['Cathy', 'Cat', 'Kate', 'Katie'],
    kathleen: ['Kathy', 'Kath', 'Kate'], margaret: ['Maggie', 'Meg', 'Peggy', 'Marge', 'Margie', 'Greta'], patricia: ['Pat', 'Patty', 'Tricia', 'Trish'],
    jennifer: ['Jen', 'Jenny'], barbara: ['Barb', 'Barbie', 'Babs', 'Basia'], susan: ['Sue', 'Susie', 'Suzy'], jessica: ['Jess', 'Jessie'], sarah: ['Sally'],
    deborah: ['Deb', 'Debbie'], debra: ['Deb', 'Debbie'], rebecca: ['Becky', 'Becca'], sharon: ['Shari'], cynthia: ['Cindy'], pamela: ['Pam'],
    christine: ['Chris', 'Christy', 'Tina'], christina: ['Chris', 'Christy', 'Tina'], rachel: ['Rach'], carolyn: ['Carol', 'Lyn'], janet: ['Jan'],
    virginia: ['Ginny', 'Ginger'], victoria: ['Vicky', 'Vicki', 'Tori'], jacqueline: ['Jackie'], frances: ['Fran', 'Frannie'], kimberly: ['Kim'],
    michelle: ['Shelly', 'Mich'], dorothy: ['Dot', 'Dottie', 'Dolly'], melissa: ['Mel', 'Missy'], stephanie: ['Steph'], theresa: ['Terry', 'Tess', 'Tessa'],
    teresa: ['Terry', 'Tess', 'Tessa'], kathryn: ['Kathy', 'Kate'], judith: ['Judy'], samantha: ['Sam', 'Sammy'], abigail: ['Abby', 'Gail'],
    danielle: ['Dani'], amanda: ['Mandy'], nicole: ['Nicki', 'Nikki'], angela: ['Angie'], beverly: ['Bev'], marilyn: ['Mari'], gloria: ['Glo'],
    florence: ['Flo', 'Flossie'], mildred: ['Millie'], lillian: ['Lily', 'Lil'], josephine: ['Jo', 'Josie'], henrietta: ['Hattie', 'Etta'],
    geraldine: ['Geri', 'Gerry'], marjorie: ['Marge', 'Margie'], loretta: ['Lottie', 'Retta'], lucille: ['Lucy', 'Lu'], louise: ['Lou', 'Lulu'],
    eleanor: ['Ellie', 'Nell', 'Nora'], winifred: ['Winnie', 'Freda'], rosemary: ['Rosie', 'Ro'], bertha: ['Bertie'], beulah: ['Bea'],
    guadalupe: ['Lupe', 'Lupita'], josefina: ['Josie', 'Fina'], maria: ['Mari'], alejandra: ['Ale'], beatriz: ['Bea', 'Betty'], lucia: ['Lucy'],
    soledad: ['Sole', 'Chole'], yolanda: ['Yoli'], concepcion: ['Concha', 'Conchita'], dolores: ['Lola', 'Loli'], mercedes: ['Meche', 'Merche'],
    rosario: ['Charo'], francisca: ['Paca', 'Paquita'], isabel: ['Isa', 'Chabela'], katarzyna: ['Kasia', 'Kate', 'Kat'], malgorzata: ['Gosia', 'Malgosia'],
    agnieszka: ['Aga'], magdalena: ['Magda'], joanna: ['Asia', 'Jo'], anna: ['Ania', 'Annie', 'Ann'], zofia: ['Zosia', 'Sophie'],
    ekaterina: ['Katya'], svetlana: ['Sveta'], natasha: ['Nat'], tatiana: ['Tanya'], olga: ['Olya'], irina: ['Ira'], anastasiya: ['Nastya'],
    giovanna: ['Gio', 'Vanna'], francesca: ['Fran', 'Franca'], alessandra: ['Ale', 'Sandra'], valentina: ['Vale', 'Tina'], fatima: ['Fati'],
    aisha: ['Ish'], khadija: ['Dija'], priyanka: ['Pri'], priya: ['Pri'], lakshmi: ['Laks'], hong: ['Hong'], thi: ['Thi'],
    mary: ['Molly', 'Polly', 'Mae', 'Mamie'], martha: ['Marty', 'Patsy'], harriet: ['Hattie'], charlotte: ['Lottie', 'Charlie'], caroline: ['Carrie'],
    emily: ['Em', 'Emmy'], emma: ['Em', 'Emmy'], alexandra: ['Alex', 'Lexi', 'Sasha'], gabriel: ['Gabe'], gabriela: ['Gabi', 'Gaby'], isabella: ['Bella', 'Izzy'],
    olivia: ['Liv', 'Livvy'], sophia: ['Sophie'], madeline: ['Maddie'], genevieve: ['Gen', 'Genny', 'Vivi', 'Gigi'], evelyn: ['Evie'], ingrid: ['Inga'],
    miriam: ['Mimi'], mordechai: ['Motti'], chukwuemeka: ['Emeka'], oluwaseun: ['Seun'], adaeze: ['Ada'], ngozi: ['Ngo'],
    keiko: ['Kei'], yusuf: ['Yusy'], omar: ['Omi'], duncan: ['Dunc'], padraig: ['Paddy', 'Podge'],
    siobhan: ['Shiv', 'Shivaun'], astrid: ['Asta'], erik: ['Rik'], sven: ['Svenne'], luc: ['Lucky'], marguerite: ['Margo', 'Daisy', 'Peggy'],
    anneliese: ['Anne', 'Liese', 'Anna'], devika: ['Devi'], bartholomew: ['Bart', 'Barty'], rosa: ['Rosie'], fiona: ['Fi'],
    rafiqul: ['Rafi'], jean: ['Jeannie'], thandiwe: ['Thandi'], luz: ['Lucecita'], ana: ['Anita'], rose: ['Rosie'], joao: ['Jo'], pedro: ['Pete'],
  };
  // Surrogate pools (hide in plain sight). A made-up name must read like the real names around it, so the people pools are
  // ordinary, ethnically mixed US names, most common first (the Surrogator draws with a lean toward the head of each list).
  // Ordinary words (Will, Rose, Brown, Hill), eponym-prone or clinical words and names under four letters are left out: such
  // a surrogate would read as a word, and a short one does not survive a lower-case round trip. The Surrogator never hands
  // out an entry that is a word of the input or of the session (so a real "Smith, Maria" never meets a made-up Smith or
  // Maria). The pools are used only for replacement: no detector reads them. People, streets, cities and organizations
  // are disjoint, so one made-up word never plays two roles.
  const FAKE_FIRST = words(`
    James Mary Michael Patricia Robert Jennifer John Linda David Elizabeth William Barbara Richard Susan Joseph Jessica
    Thomas Sarah Christopher Karen Charles Lisa Daniel Nancy Matthew Betty Anthony Sandra Donald Margaret Steven Ashley
    Paul Kimberly Andrew Emily Joshua Donna Kenneth Michelle Kevin Brian Amanda Timothy Melissa Ronald Deborah George
    Stephanie Jason Rebecca Edward Sharon Jeffrey Laura Ryan Cynthia Jacob Kathleen Gary Nicholas Angela Eric Shirley
    Jonathan Brenda Stephen Emma Larry Anna Justin Pamela Scott Nicole Brandon Samantha Benjamin Katherine Samuel
    Christine Gregory Debra Alexander Rachel Patrick Carolyn Janet Raymond Maria Catherine Dennis Jerry Diane Tyler Olivia
    Aaron Julie Jose Joyce Adam Victoria Nathan Kelly Henry Christina Zachary Lauren Douglas Joan Peter Evelyn Kyle
    Judith Noah Andrea Ethan Hannah Jeremy Megan Walter Cheryl Jacqueline Keith Martha Roger Teresa Sean Gloria Gerald
    Sara Carl Janice Harold Dylan Kathryn Arthur Abigail Lawrence Sophia Frances Jesse Jean Bryan Alice Billy Judy Bruce
    Isabella Gabriel Julia Logan Denise Alan Juan Doris Albert Marilyn Willie Danielle Elijah Beverly Wayne Charlotte
    Natalie Vincent Theresa Diana Brittany Ralph Kayla Bobby Alexis Russell Lori Bradley Marie Philip Eugene Luis Carlos
    Miguel Jorge Antonio Manuel Pedro Alejandro Ricardo Fernando Javier Rafael Sergio Eduardo Roberto Mario Hector Ramon
    Guadalupe Rosa Carmen Lucia Elena Sofia Gabriela Adriana Veronica Yolanda Marisol Alma Leticia Silvia Beatriz
    Esperanza Linh Minh Huong Tuan Hung Thanh Ming Jian Xiao Hiroshi Kenji Yuki Akiko Hyun Priya Anjali Deepak
    Rajesh Sanjay Ravi Sunil Arjun Neha Pooja Kavita Vijay Amit Rahul Sunita Ahmed Mohammed Omar Fatima Aisha Hassan
    Yusuf Layla Khalid Tariq Samir Nadia Leila Darnell Tyrone Jamal Deshawn Terrell Latoya Keisha Tamika Shanice Aaliyah
    Malik Andre Marcus Reginald Cedric Lamar Monique Tanisha Kendra Yvonne Bernard Stanley Leonard Francis Herbert Melvin
    Agnes Irene Dorothy Mildred Helen Ruth Virginia Marjorie Lois Phyllis Norma Wanda Gladys Peggy Tammy Tina Rhonda
    Wendy Krzysztof Tomasz Piotr Andrzej Pawel Marek Agnieszka Katarzyna Malgorzata Dmitri Sergei Ivan Olga Natalia Irina
    Svetlana Giovanni Giuseppe Salvatore Angelo Vincenzo Francesca Rosalie Kwame Kofi Chidi Amara Emeka
    Tigist Mehmet Ayse Caitlin Colleen Brendan Declan Siobhan Liam Connor Kieran Maeve Erin Shannon Kristen
    Courtney Heidi Gretchen Ingrid Lars Erik Hans Klaus Greta Dolores Ernesto Rodrigo Armando Alfredo Raul Ignacio Julio
    Cesar Arturo Gilberto Rogelio Esteban Diego Mateo Santiago Camila Valentina Daniela Paola Lorena Mariana Ximena Rocio
    Consuelo Graciela Martina Abril Isabel Leonor
  `);
  // which of them read as a woman's or a man's name, so "wife Bernadette" gets a woman's name and "Mr. Jones's son" a man's
  // (the rest, Kelly, Jesse, Jean, Alexis, Thanh, Yuki, are drawn when nothing says)
  const FAKE_FEMALE = setOf(words(`
    Mary Patricia Jennifer Linda Elizabeth Barbara Susan Jessica Sarah Karen Lisa Nancy Betty Sandra Margaret Ashley
    Kimberly Emily Donna Michelle Amanda Melissa Deborah Stephanie Rebecca Sharon Laura Cynthia Kathleen Angela Shirley
    Brenda Emma Anna Pamela Nicole Samantha Katherine Christine Debra Rachel Carolyn Janet Maria Catherine Diane Olivia
    Julie Joyce Victoria Christina Lauren Joan Evelyn Judith Andrea Hannah Megan Cheryl Jacqueline Martha Teresa Gloria
    Sara Janice Kathryn Abigail Sophia Frances Alice Judy Isabella Julia Denise Doris Marilyn Danielle Beverly Charlotte
    Natalie Theresa Diana Brittany Kayla Lori Marie Guadalupe Rosa Carmen Lucia Elena Sofia Gabriela Adriana Veronica
    Yolanda Marisol Alma Leticia Silvia Beatriz Esperanza Linh Huong Akiko Priya Anjali Neha Pooja Kavita Sunita Fatima
    Aisha Layla Nadia Leila Latoya Keisha Tamika Shanice Aaliyah Monique Tanisha Kendra Yvonne Agnes Irene Dorothy Mildred
    Helen Ruth Virginia Marjorie Lois Phyllis Norma Wanda Gladys Peggy Tammy Tina Rhonda Wendy Agnieszka Katarzyna
    Malgorzata Olga Natalia Irina Svetlana Francesca Rosalie Amara Tigist Ayse Caitlin Colleen Siobhan Maeve Erin
    Shannon Kristen Courtney Heidi Gretchen Ingrid Greta Dolores Camila Valentina Daniela Paola Lorena Mariana Ximena Rocio
    Consuelo Graciela Martina Abril Isabel Leonor
  `));
  const FAKE_MALE = setOf(words(`
    James Michael Robert John David William Richard Joseph Thomas Christopher Charles Daniel Matthew Anthony Donald Steven
    Paul Andrew Joshua Kenneth Kevin Brian Timothy Ronald George Jason Edward Jeffrey Ryan Jacob Gary Nicholas Eric
    Jonathan Stephen Larry Justin Scott Brandon Benjamin Samuel Gregory Alexander Patrick Raymond Dennis Jerry Tyler Aaron
    Jose Adam Nathan Henry Zachary Douglas Peter Kyle Noah Ethan Jeremy Walter Keith Roger Sean Gerald Carl Harold Dylan
    Arthur Lawrence Bryan Billy Bruce Gabriel Logan Alan Juan Albert Willie Elijah Wayne Vincent Ralph Bobby Russell
    Bradley Philip Eugene Luis Carlos Miguel Jorge Antonio Manuel Pedro Alejandro Ricardo Fernando Javier Rafael Sergio
    Eduardo Roberto Mario Hector Ramon Minh Tuan Hung Jian Hiroshi Kenji Deepak Rajesh Sanjay Ravi Sunil Arjun Vijay
    Amit Rahul Ahmed Mohammed Omar Hassan Yusuf Khalid Tariq Samir Darnell Tyrone Jamal Deshawn Terrell Malik Andre Marcus
    Reginald Cedric Lamar Bernard Stanley Leonard Francis Herbert Melvin Krzysztof Tomasz Piotr Andrzej Pawel Marek Dmitri
    Sergei Ivan Giovanni Giuseppe Salvatore Angelo Vincenzo Kwame Kofi Chidi Emeka Mehmet Brendan Declan Liam
    Connor Kieran Lars Erik Hans Klaus Ernesto Rodrigo Armando Alfredo Raul Ignacio Julio Cesar Arturo Gilberto Rogelio
    Esteban Diego Mateo Santiago
  `));
  const FAKE_FIRST_F = FAKE_FIRST.filter((w) => FAKE_FEMALE.has(w.toLowerCase()));
  const FAKE_FIRST_M = FAKE_FIRST.filter((w) => FAKE_MALE.has(w.toLowerCase()));
  const FAKE_LAST = words(`
    Smith Williams Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Anderson Taylor Moore Jackson Martin
    Perez Thompson Harris Sanchez Ramirez Lewis Robinson Walker Allen Wright Torres Nguyen Flores Adams Nelson Rivera
    Campbell Mitchell Carter Roberts Gomez Phillips Evans Diaz Parker Cruz Edwards Collins Reyes Stewart Morris Morales
    Rogers Gutierrez Ortiz Morgan Cooper Peterson Bailey Howard Ramos Richardson Watson Brooks Chavez Bennett Mendoza
    Ruiz Hughes Alvarez Castillo Sanders Patel Myers Ross Foster Jimenez Powell Jenkins Perry Sullivan Coleman Henderson
    Barnes Gonzales Vasquez Simmons Romero Patterson Hamilton Graham Reynolds Griffin Wallace Moreno Hayes Bryant Herrera
    Gibson Ellis Tran Medina Aguilar Murray Castro Marshall Owens Harrison Fernandez McDonald Kennedy Vargas Chen Freeman
    Webb Tucker Guzman Burns Crawford Olson Simpson Gordon Mendez Silva Shaw Snyder Dixon Munoz Hicks Holmes Palmer Wagner
    Robertson Boyd Salazar Meyer Schmidt Garza Daniels Ferguson Nichols Stephens Soto Weaver Payne Dunn Kelley Spencer
    Hawkins Arnold Pierce Vazquez Hansen Peters Santos Elliott Cunningham Armstrong Carroll Riley Andrews Delgado Berry
    Perkins Hoffman Johnston Matthews Pena Richards Contreras Willis Sandoval Guerrero Chapman Rios Estrada Ortega Watkins
    Greene Nunez Wheeler Valdez Harper Burke Larson Maldonado Morrison Carlson Dominguez Carr Lawson Jacobs Singh
    Vega Montgomery Oliver Jensen Harvey Williamson Gilbert Espinoza Wong Reid Hanson McCoy Garrett Burton Fuller Wang
    Rojas Lucas Marquez Yang Padilla Walsh Bowman Schultz Luna Mejia Davidson Acosta Holland Juarez Newman Pearson Curtis
    Cortez Schneider Navarro Figueroa Keller Avila Molina Hopkins Campos Barnett Caldwell Lambert Miranda Byrd Craig Ayala
    Frazier Carrillo Sutton Fleming Shelton Schwartz Norris Jennings Watts Duran Cohen McDaniel Moran Parks Vaughn Becker
    Deleon Leon Benson Haynes Horton Lyons Pham Thornton Warner Cabrera McKinney Mann Zimmerman Dawson Lara Fletcher
    Kowalski Nowak Wisniewski Wojcik Kowalczyk Kaminski Lewandowski Zielinski Szymanski Mazur Krawczyk Dabrowski Novak
    Petrov Ivanov Kozlov Popov Volkov Romano Russo Esposito Ricci Marino Greco Bruno Gallo Conti Costa Rizzo Lombardi
    Moretti Colombo Ferrari Mancini Okafor Okonkwo Adeyemi Mensah Owusu Boateng Abdi Hussein Khan Rahman Ibrahim Mahmoud
    Haddad Nasser Sharma Gupta Kumar Shah Mehta Reddy Iyer Desai Joshi Chowdhury Nair Huang Zhang Zhao Zhou Tanaka
    Yamamoto Nakamura Suzuki Watanabe Sato Choi Kang Jung Yoon Hoang Phan Huynh Dang Duong Truong Schmitt Fischer
    Hoffmann Krueger Johansson Larsen Nielsen Andersen Petersen Byrne Doyle Gallagher Quinn Brennan McMahon
    Fitzgerald Donovan
  `);
  // street names (written with a suffix the original had: "Maple Ave", "412 Cedar St")
  const FAKE_STREETS = words(`
    Maple Cedar Pine Walnut Chestnut Spruce Birch Hickory Sycamore Poplar Cherry Magnolia
    Mill Union Market Spring Prospect Pleasant Ridge Sunset Railroad Meadow Orchard Forest River Lake Hillside Valley
    Bridge Academy Broad Liberty Jefferson Monroe Locust Mulberry Dogwood Aspen Cottonwood Beech Linden Grove Highland
    Fairview Woodland Lakeview Ridgewood Edgewood Glenwood Sherwood Kenwood Brookside Railway Juniper Hemlock
    Maplewood Oakhurst Pinehurst Cedarhurst Wynnewood Thornwood Briarcliff Glenmoor Ferndale Kentwood Dunmoor
    Woodmere Lynnwood Elmcrest Oakdale Ravenwood Stonehaven Foxcroft
  `);
  // towns: ordinary US place names from outside the region the tool is used in (no Western New York or upstate names)
  const FAKE_CITIES = words(`
    Springfield Riverton Milford Georgetown Salem Ashland Greenville Dover Bristol Burlington Camden Dayton Easton
    Lebanon Manchester Newport Plymouth Richmond Shelbyville Trenton Windsor Arlington Bedford Canton Centerville Clayton
    Dalton Elkton Glendale Hanover Lexington Marysville Newton Oakland Princeton Bloomington Columbia Fayetteville
    Frankfort Hillsboro Lakewood Smyrna Waverly Westminster Winchester Brookfield Danville Farmington Greenwood
    Harrisburg Fremont Rockford Wheaton Dublin Medford Concord Sedalia Tupelo Ocala Yuma Visalia Bozeman Missoula
  `);
  // saints for a church, school or hospital named after one ("St. Joseph's church" -> "St. Brendan's church"): written after
  // the "St." of the original; none is in the people pools
  const FAKE_SAINTS = words(`
    Alban Dunstan Columba Cuthbert Ambrose Boniface Benedict Clement Ignatius Bartholomew Aloysius Anselm Gertrude Hedwig
    Cecilia Perpetua Casimir Stanislaus Hyacinth Florian Barnabas Polycarp Wenceslaus Scholastica Philomena Cyprian
  `);
  // a town of two words keeps its ordinary first or last word around a made-up one (North Tonawanda -> North Dover,
  // Niagara Falls -> Dover Falls, Erie County -> Dover County)
  const CITY_KEEP_PREFIX = setOf(words(`North South East West New Fort Ft Mount Mt Lake Port Cape`));
  const CITY_KEEP_SUFFIX = setOf(words(`Falls Springs Heights Park City Beach Hills Village Junction Center Centre Valley Harbor Island Township Twp County Parish`));
  // organizations by kind: a hospital is replaced by a hospital, a pharmacy by a pharmacy. The first word of each is its
  // own (it is what the Surrogator checks against the input and marks as handed out); the words after it are the kind.
  const FAKE_ORG_POOLS = {
    hospital: ['Lakeshore General Hospital', 'Northside Medical Center', 'Valleybrook Regional Hospital', 'Crestview Community Hospital', 'Southpoint Medical Center', 'Riverbend Hospital', 'Bayfield Memorial Hospital', 'Eastbrook General Hospital'],
    cancer: ['Pinecrest Cancer Center', 'Hillcrest Cancer Institute', 'Northpoint Oncology', 'Meadowbrook Cancer Center', 'Westbury Cancer Institute', 'Clearbrook Oncology Associates'],
    clinic: ['Brookhaven Family Clinic', 'Westgate Medical Group', 'Eastview Primary Care', 'Parkside Health Clinic', 'Lakemont Medical Associates', 'Stonegate Family Practice'],
    pharmacy: ['Clearwater Pharmacy', 'Oakmont Pharmacy', 'Lakeside Drugs', 'Sunnyside Pharmacy', 'Bellmont Pharmacy', 'Kingsley Drug'],
    insurer: ['Bayview Health Plan', 'Summitview Mutual Insurance', 'Fairhaven Insurance', 'Northstar Health Plan', 'Ridgeline Benefits', 'Silvercrest Insurance'],
    nursing: ['Stonebridge Nursing and Rehabilitation', 'Kingsbridge Rehab Center', 'Willowbrook Senior Living', 'Maplecrest Nursing Home', 'Oakhaven Rehabilitation Center', 'Briarwood Care Center'],
    school: ['Eastfield Elementary School', 'Northridge High School', 'Lakeland Middle School', 'Westhaven Community College', 'Rivermont Academy', 'Crestwood Elementary'],
    employer: ['Crestline Manufacturing', 'Ridgeway Logistics', 'Summitline Packaging', 'Northgate Distribution', 'Bayside Electric', 'Harborline Freight', 'Keystone Machining', 'Tri-County Builders'],
    shop: ['Freshway Market', 'Hilltop Grocery', 'Greenleaf Market', 'Fairmart Foods', 'Corner Pantry', 'Sunfield Market'],
    church: ['Trinity Lutheran Church', 'Calvary Baptist Church', 'Bethany Community Church', 'Shiloh Baptist Church', 'Emmanuel Lutheran Church', 'Covenant Fellowship Church'],
    unknown: ['Lakehurst Associates', 'Northbay Services', 'Brookline Center', 'Westbrook Partners', 'Clearview Group', 'Ridgefield Community Services'],
  };
  // a name with a kind word of its own ("Kenmore Mercy Hospital", "Delaware Pharmacy") keeps that word after a made-up stem
  const FAKE_ORG_STEMS = words(`
    Lakemoor Northfield Brookdale Westmont Pinegrove Hollybrook Clearfield Oakview Riverside Parkview Lakeridge Bayshore
    Sunridge Crestmont Southgate Eastlake Valleyview Stonecrest Glenbrook Kingsgate Fairlawn Elmhurst Ashbrook Cedarcrest
    Highpoint Silverbrook Greenbriar Meadowview Hazelwood Larchmont Thornbury Wildwood Foxhall Ironwood Bramblewood
  `);
  // the kind of a known local organization (detection lists it in LOCAL_ORGS; this map is read only for replacement)
  const LOCAL_ORG_KIND = {
    moog: 'employer', geico: 'insurer', elderwood: 'nursing', sumitomo: 'employer', praxair: 'employer', linde: 'employer', 'delaware north': 'employer',
    'rich products': 'employer', tops: 'shop', wegmans: 'shop', kaleida: 'hospital', 'catholic health': 'hospital', 'erie county medical center': 'hospital',
    ecmc: 'hospital', roswell: 'cancer', 'roswell park': 'cancer', 'brothers of mercy': 'nursing', 'canterbury woods': 'nursing', 'weinberg campus': 'nursing',
    amberleigh: 'nursing', beechwood: 'nursing', 'terrace view': 'nursing', schofield: 'nursing', 'father baker': 'unknown', absolut: 'nursing',
    'hospice buffalo': 'nursing', 'mercy flight': 'unknown', 'mcguire group': 'nursing', 'garden gate': 'nursing', 'harris hill': 'nursing',
    'autumn view': 'nursing', 'ellicott center': 'nursing', 'kenmore mercy': 'hospital', 'sisters hospital': 'hospital', 'buffalo general': 'hospital',
    'millard fillmore': 'hospital', 'mercy hospital': 'hospital', oishei: 'hospital', 'independent health': 'insurer', univera: 'insurer', fidelis: 'insurer',
    highmark: 'insurer', excellus: 'insurer', 'blue cross': 'insurer', bcbs: 'insurer', medicaid: 'insurer', medicare: 'insurer', humana: 'insurer', aetna: 'insurer',
    cigna: 'insurer', cvs: 'pharmacy', walgreens: 'pharmacy', 'rite aid': 'pharmacy', aldi: 'shop', walmart: 'shop', target: 'shop',
  };
  // First name -> sex, for a made-up first name of the same sex as the real one (read only by the Surrogator; no detector
  // reads it). f/m: at least 90% one sex in the SSA data; fs/ms: the same for names more common as a surname (Lee, Kelly);
  // u: given names used by both sexes.
  // GENERATED:NAME_SEX begin (tools/build-name-sex.js from vendor/names; do not edit by hand)
  const NAME_SEX_DATA = {
    f: `
      aaliyah abagail abbey abbie abbigail abby abigail abigale abigayle abril achsah ada adah adaline adalyn adalynn
      adamaris adda addie addisyn addyson adela adelaide adele adelia adelina adeline adell adella adelle adelyn adilene
      adina adison adline adria adriana adriane adrianna adrianne adriene adrienne adyson affie afton agatha aggie agnes
      agusta aida aileen ailene aili aimee ainsley aisha aiyana aja akeelah akira alabama alaina alana alani alanna
      alannah alayna alberta albertha albertina albertine albina alcie alda aldona aleah alease alecia aleen aleena
      alejandra alena alene alesha alesia alessandra aleta aletha alethea alexa alexandr alexandra alexandrea alexandria
      alexia alexina alexus alexys alfreda alia aliana alice alicia alida alina aline alisa alisha alison alissa alisson
      alivia aliya aliyah aliza alize alla allean alleen allena allene alline allison allisson ally allyson allyssa alma
      almeda almedia almeta almina almira almyra aloma alondra alphonsine alta altha althea altie alvena alvera alverda
      alverta alvina alwilda alwina alyce alycia alys alysa alyse alysha alysia alyson alyssa alyssia alyvia alzina amalia
      amalie amanda amani amara amaris amber amberly amelia amelie america ami amiah amie amina amira amirah amiya amiyah
      amma ammie amy amya ana anabel anabella anabelle anahi anais anastacia anastasia andrea andria angela angelia
      angelic angelica angelina angeline angelique angelita angella angie anice anie anika anissa anita anitra aniya
      aniyah anjali anjanette anjelica ann anna annabel annabell annabella annabelle annalise annamae annamarie anne
      anneliese annemarie anner annetta annette annice annie annika annis annmarie anona antionette antoinette antonetta
      antonette antonia antonina anya april ara arabella araceli aracely arah araminta ardath ardelia ardella ardelle
      ardeth ardis ardith ardyce areli arely aretha argie aria ariana ariane arianna arie ariella arielle arizona arkie
      arla arleen arlena arlene arleth arletta arline arly arlyne armida arminda arminta arnetta arrie arta artelia
      arvilla aryana aryanna asha ashanti ashely ashlea ashlee ashleigh ashley ashli ashlie ashly ashlyn ashlynn ashtyn
      asia ason aspen assunta astrid athena attie aubree aubrie audra audrey audriana audrianna audrina audry augusta
      augustina aura aurelia aurilla aurora aurore autumn ava avah averi averie avie avis ayana ayanna ayesha ayla aylin
      azalee azaria azul azzie babette bailee bama bambi barb barbara barbie barbra baylee baylie beadie beatrice beatrix
      beatriz beaulah beckie becky beda belen belia belinda bella belle belva benita berdie berenice bernadette bernadine
      bernardine berneice bernetta bernice berniece bernita berta bertha bertie bertina bess besse bessie beth bethann
      bethany bethzy betsey betsy bette bettie bettina betty bettye bettyjane bettylou beula beulah bev beverlee beverley
      beverly beyonce bianca biddie billye birdella birdie birtha birtie blanca blanch blanche blanchie bobbi bobbye
      bonita bonnie bonny braelyn brandee brandi brandie brandy breana breann breanna breanne bree brenda brenna breonna
      bria briana brianda brianna brianne bridget bridgett bridgette brielle brigette brigid brigitte brionna brisa
      britany britney britni britny britta brittaney brittani brittanie brittany brittnay brittnee brittney brittni
      brittnie brittny brooke brooklyn brooklynn bryana bryanna brylee bryn brynlee brynn buelah buena buffy bula bulah
      buna byrdie caddie cadence cailyn caitlin caitlyn caitlynn caldonia caleigh cali calista calla callie cami camila
      camilla camille camisha cammie camryn candace candi candice candida candis candy candyce capitola cappie cara caren
      cari carie carin carina carisa carissa carla carlee carleen carleigh carlene carley carli carlie carlota carlotta
      carly carlyn carma carmel carmela carmelita carmella carol carolann carole carolee carolina caroline carolyn
      carolyne carolynn carri carrie caryl caryn casandra casie cassandra cassidy cassie cassondra catalina catharine
      catherine cathern cathi cathie cathleen cathrine cathryn cathy catina catrina cayla caylee cecelia cecile cecilia
      cecily ceil celena celesta celeste celestia celestine celia celie celina celine ceola chaka chana chanda chandra
      chanel chanelle chanie channie chantal chante chantel chantelle charissa charisse charity charla charlee charleen
      charlene charline charlize charlotta charlotte charlottie charlsie charmaine charolette chasity chastity chaya
      chelsea chelsey chelsi chelsie chelsy cher cherelle cheri cherie cherilyn cherise cherish cherrelle cherri cherrie
      cherryl cheryl cheryle cheryll chessie chestina cheyanne cheyenne chimere china chiquita chloe chloie chrissie
      chrissy christa christal christeen christel christen christena christene christi christiana christie christin
      christina christine christy chrystal chyna chynna ciara ciarra cicely ciera cierra ciji cinda cindi cindy cinthia
      citlali citlalli claire clara clarabelle claribel clarice clarinda clarine clarisa clarissa classie claudette
      claudia claudine cleda clella clementina clementine clemie clemma clemmie cleola cleone cleora cleta cleva clevie
      cliffie cloe clora clotilda clotilde clyda clydie clytie coleen colette colleen concetta connie constance consuela
      consuelo contina cora coraima coral coralie corda cordelia cordia cordie corean corene coretta cori corie corina
      corine corinna corinne cornelia cornie corrie corrina corrine courtney creola cressie crissie crissy crista cristal
      cristen cristi cristin cristina cristine cristy crysta crystal cydney cyndi cyntha cynthia dafne dagmar dagny dahlia
      daija daijah daisey daisha daisie daisy daisye daja dalia damaris danae daneen danelle danette dania danica daniela
      daniella danielle danika danita danna dannielle danyel danyell danyelle daphne dara darci darcie darcy daria dariana
      darla darleen darlene darline darlyne dasia davina dawn dawna dawne dayami dayana dayanara dayle dayna dayse deana
      deandra deann deanna deanne deasia deb debbi debbie debbra debby debera debi debora deborah deborrah debra debrah
      debroah dedra deeann deedee deena deetta deidra deidre deirdre deja dejah delcie delfina delia deliah delila delilah
      delina delinda delisa della dellar dellia dellie delma delois delora delores deloris delpha delphia delphine delsie
      delta demetra demetria demi dena deneen denese denice denine denise denisha denisse denita desirae desiree dessa
      dessie destany destinee destiney destini destiny deyanira dezzie diamond dian diana diandra diane diann dianna
      dianne dicie dicy dillie dimple dina dinah dione dixie diya djuana djuna docia dola dollie dolly dollye dolores
      doloris domenica dominga domonique dona donie donita donna dora dorathea dorathy dorcas doreen dorene doretha
      doretta dori dorinda dorine doris dorla dorotha dorothea dorothy dorris dortha dorthea dorthey dorthy dosha doshia
      doshie dosia dossie dot dottie dotty dovie drema drucilla drusilla dulce dulcie dyan earlean earlene earline
      earnestine eartha eathel ebba eboni ebony echo eda eden edith edla edmonia edna ednah edra edrie edwina edyth edythe
      effa effie eileen eithel elaina elaine elana elayne elba elberta elda eldora eleanor eleanora eleanore elease electa
      elena eleni elenor elenora elenore eleonora eleonore elfie elfreda elfrieda eliana elianna elida elinor elinore
      elisa elisabeth elise elissa eliza elizabet elizabeth elizbeth elizebeth ella ellamae ellar elle ellen elliana ellie
      ellyn elma elmina elmira elmire elmyra elna elnora elodie elois eloisa eloise elouise elsa elsie elta elva elvera
      elvia elvie elvina elvira elwanda elyse elyssa elzada ema emaline emelia emelie emeline emely emerald emilee emilia
      emilie emily emma emmalee emmaline emmer emmie emmy emogene ena enid enola enriqueta eola eppie epsie era erica
      ericka erika erin eris erla erlene erlinda erline erma ermina ermine erna ernestina ernestine erykah eryn esmeralda
      esperanza essence essie esta estefani estefania estefany estela estell estella estelle ester esther estie etha ethel
      ethelene ethelyn ether ethie ethyl ethyle etna etta ettie eudora eugenia eugenie eula eulah eulalia eulalie euna
      eunice euphemia eura eva evalena evaline evalyn evangelina evangeline eve evelena evelin evelina eveline evelyn
      evelyne ever evette evia evie evita evon evonne exa exie fabiola fae fairy faith falon fannie fanny fannye farrah
      fatima fawn faye felecia felicia felicie felicity felipa felisha fern fernanda ferne fidelia filomena fiona flavia
      fleda fleeta fleta flo flonnie flora florance florence florene floretta florida florie florine florrie flossie floy
      fran frances francesca francina francine francisca francisqui freda frederica fredericka freeda freida frida frieda
      frona fronia fronie fronnie fumiko gabriela gabriella gabrielle gail galilea gaye gayla gayle gaylene gaynell
      gearldine gena genesis geneva genevieve genevra genie gennie genoveva georganna georgeann georgeanna georgene
      georgetta georgette georgia georgiana georgiann georgianna georgie georgina georgine geraldine geralyn gerda geri
      germaine gerri gertha gertie gertrude gia giada giana gianna gidget gigi gilda gillian gina ginger ginny giovanna
      girtha gisele giselle gisselle giuliana gladyce gladys glenda glendora glenna glennie glennis glinda gloria glynda
      glynis golda goldia goldie grace gracelyn gracie graciela grayce grecia gregoria greta gretchen gretta grisel
      griselda gunda gussie gusta gustie gwen gwenda gwendolyn gwyneth hadassah hailee hailey hailie haleigh haley hali
      halie halle hallie hana hannah harlene harmony harriet harriett harriette haruko hassie hattie haven haylee hayleigh
      hayley haylie hazel hazelle hazle heather heaven hedwig hedy heidi heidy helaine helen helena helene helga hellen
      helma helyn henretta henrietta henriette herlinda herma hermina hermine herminia hertha hessie hester hettie hetty
      hilah hilary hilda hildegard hildegarde hildred hildur hillary hilma holli holly honora hope hortencia hortense
      hortensia hulda huldah ica icey icie icy ida idabelle idamae idell idella iesha ieshia ila ilah ilda ilene iliana
      ilma ilo ilona ima imani imelda imo imogene ina india indiana inell ines inez inga ingeborg ingrid iola iona ione
      irena irene iridian irine iris irma irva isa isabel isabela isabell isabella isabelle isadora isamar isis isla
      isobel itzel iva ivah ivana ivette ivonne iyana iyanna izabella izabelle izetta izola izora jacalyn jacey jackeline
      jacki jacklyn jaclyn jacque jacquelin jacqueline jacquelyn jacquelynn jacquline jacqulyn jada jade jaeda jaelyn
      jaelynn jaida jailene jailyn jaimee jaimie jakayla jaleesa jalisa jalissa jaliyah jalyn jalynn jami jamila jamiya
      jamya jana janae janay jane janeen janel janell janelle janene janessa janet janette janey janiah janice janie
      janine janis janiya janiyah janna jannette jannie janyce jaquelin jaqueline jaslene jaslyn jasmin jasmine jasmyn
      jasmyne jaunita jaycee jaycie jayda jayde jayla jaylah jaylee jayleen jaylene jaylyn jaylynn jayne jazlene jazlyn
      jazlynn jazmin jazmine jazmyn jazmyne jean jeana jeane jeanetta jeanette jeanie jeanine jeanna jeanne jeannette
      jeannie jeannine jemima jena jenelle jenifer jenilee jenna jenni jennie jennifer jenniffer jenny jeraldine jeri
      jerica jerilyn jerilynn jerri jerrica jerrie jerrilyn jerusha jeryl jesenia jesica jessenia jessi jessica jessika
      jessye jetta jettie jill jillian jimena jinnie jo joan joana joanie joann joanna joanne jocelyn jocelyne jocelynn
      jodi joell joella joelle joellen joetta joette johana johanna johannah johnna joi joleen jolene jolette jolie jonell
      joni jonna jordin jordyn joretta jorja josefa josefina josefita joselin joseline joselyn josephine josette josie
      josiephine jossie journey jovita joy joyce joycelyn juana juanita judi judie judith judy judyth juli julia juliana
      juliann julianna julianne julie juliet juliette julisa julissa june junia junie justina justine kaaren kacey kaci
      kacie kacy kadence kadijah kaela kaelyn kaia kaila kailee kailey kailyn kaitlin kaitlyn kaitlynn kaiya kala kaleena
      kaleigh kalene kaley kali kalie kaliyah kallie kalyn kami kamila kamilah kamora kamryn kandace kandi kandice kandy
      kanesha kanisha kara karan karen kari karie karin karina karissa karla karlee karlene karley karli karlie karly
      karma karol karolyn karon karri karrie karsyn karyl karyme karyn kasandra kasie kassandra kassidy kassie katarina
      kate katelin katelyn katelynn katerina kathaleen katharina katharine katharyn katherin katherine kathern katheryn
      kathey kathi kathie kathleen kathlene kathlyn kathrine kathryn kathryne kathy kathyrn kati katia katie katina katlin
      katlyn katlynn katrina kattie katy kay kaya kaycee kaydence kaye kayla kaylah kaylan kaylee kayleigh kaylen kaylene
      kayley kayli kaylie kaylin kaylyn kaylynn kazuko keanna keara kecia keely keesha keila keira keisha kelcie keli
      kelis kellee kelli kellie kelsea kelsey kelsi kelsie kendra kenia kenisha kenna kennedi kenya kenzie keri kerri
      kerrie kesha keshia keyla khadijah khalilah khloe kia kiana kianna kiara kiarra kiera kierra kiersten kiley
      kimberely kimberlee kimberley kimberli kimberlie kimberly kimora kindra kira kirsten kirstie kirstin kisha kittie
      kitty kiya kiyoko kizzie kizzy kori kortney kourtney krissy krista kristal kristan kristen kristi kristie kristin
      kristina kristine kristy kristyn krysta krystal krysten krystin krystina krystle kya kyara kyla kylah kylee kyleigh
      kylene kylie kyra kyrie lacey laci lacie ladonna lahoma laila lailah lainey laisha lakeisha laken lakendra lakesha
      lakeshia lakisha lala lana lanette lani lanie lanita laquita larae laraine larissa lashanda lashonda lashunda
      lasonya lassie latanya latarsha latasha latesha latifah latisha latonia latonya latoria latosha latoya latoyia
      latrice latricia latrina launa laura laureen laurel lauren laurene lauretta laurette lauri laurie laurine lauryn
      lavada lavenia lavera laverna lavina lavinia lavona lavonda lavonia lavonne lawanda layla laylah lea leafy leah
      leala leana leandra leaner leann leanna leanne leatha leatrice leda leeann leesa leia leigh leila leilani leisa
      leisha leitha lela lelah lelar lelia lella lempi lena lenna lenora lenore leola leoma leona leonia leonie leonor
      leonora leonore leontine leora leota lera lesa lesia leslee lesli lesly lessie lesta leta letha lethia leticia
      letitia letta lettie letty leva lexi lexie lexis lexus leyla lia liana liane libbie libby liberty lida liddie lidia
      lidie lila lilah lilia lilian liliana lilianna lilie lilla lillia lillian lilliana lillianna lillie lilly lily
      lilyan lilyana lina linda lindsay lindsey linette linnea linnie linsey lisa lisbeth lise lisette lisha lissa
      lissette lissie lita litha littie litzy livia liz liza lizabeth lizbeth lizeth lizette lizzie lockie lois lola
      lolita lolla lollie loma lona londyn loni lonna lora loraine lorayne lorean loreen lorelai lorelei lorena lorene
      loretta loretto lori loriann lorie lorinda lorine lorna lorraine lorrayne lorri lorrie lossie lota lotta lottie lou
      louann louanna louella louetta louisa louise louisiana loula lourdes louvenia lovie lovina loyce luana luann luanne
      luberta lucetta lucia luciana lucie lucile lucille lucina lucinda lucindy lucretia lucy luda ludie lue luella luetta
      lugenia luisa lula lulah lular lulie lulu lura lurana lurena lurline lutie luvenia luvinia luz lyda lydia lyla lyn
      lynda lyndia lyndsay lyndsey lynette lynne lynnette lynsey lyric mabel mabell mabelle mable macel macey machelle
      maci macie mackenzie macy madaline madalyn madalynn maddison madeleine madelene madeline madelyn madelynn madge
      madie madilyn madilynn madisen madison madisyn madlyn madonna madora madyson mae maebell maebelle maegan maeve
      mafalda magdalen magdalena magdalene magen maggie magnolia mahala mahalia mahalie maia maira maiya makaila makala
      makayla makena makenna makenzie malaya maleah malia malinda malissa malissie maliyah mallie mallorie mallory malorie
      malvina mame mamie mammie manda mandi mandie mandy manerva manervia manie manila manuela manuelita mara maralyn
      maranda marcela marcelina marceline marcella marcelle marci marcia marcie marcy mardell mareli marely maren margaret
      margarete margaretha margarett margaretta margarette margarita margarite marge margene margeret margery marget
      margie margo margot margret margrett margretta marguerite margueritta margurite margy mari maria mariah mariam
      marian mariana marianita mariann marianna marianne maribel maribeth maricela marie mariel mariela marietta marilee
      marilla marilou marilyn marilynn marina marinda marisa marisela marisol marissa marita maritza mariyah marjorie
      marjory markita marla marlana marlee marleen marlen marlena marlene marley marlie marlo marlys marni marnie marnita
      marolyn marquita marry marsha marta martha martika martina marva marvel mary maryam maryann maryanne marybelle
      marybeth maryellen maryjane maryjo marylee marylin marylou marylouise marylyn masako mathilda mathilde matie matilda
      matilde mattie mattye maud maude maudie maura maureen maurine mavis maxine may maya maybell maybelle maye mayme
      maymie mayra mazie mckayla meadow meagan meaghan mechelle meda media meg megan meggan meghan meghann melanie melany
      melba melina melinda melisa melissa melissia mellie mellisa mellissa melodee melodie melody melonie melony melva
      melvina mendy mercedes meredith merilyn merlene merna merri merrie merrilee merrily merry mertie meryl meta metha
      metta mettie mia miah micaela micayla michaela michaele michele michelina michell michelle mickie miesha migdalia
      mignon mikaela mikaila mikala mikalah mikayla mila milagros milda mildred milissa millicent millie milly mima mimi
      mina minda mindi mindy minerva minervia minna minnie minta mintie mira miranda mireya miriah miriam mirtie missie
      missouri missy misti mistie misty mittie mitzi miya moesha moira mollie molly mona monica monika monique monna
      monnie monserrat montserrat moriah mossie mozell mozella mozelle muriel mya myah myla mylee mylie myra myranda myrl
      myrle myrna myrta myrtice myrtie myrtis myrtle nada nadia nadine naima nakisha nakita nallely nan nana nanci nancie
      nancy nanette nanie nannette nannie naoma naomi narcissus natalee natalia natalie nataly natalya natasha nathalia
      nathalie nathaly natosha nautica nayeli nayely nealie nedra neha nelda nelia nelie nell nella nelle nellie nelly
      nena neola neoma neppie nereida neta netta nettie neva nevada nevaeh neveah nia nichelle nichole nicki nicole
      nicolette nicolle niki nikia nikita nikki nikole nila nilda nina ninnie nira nita nobie noelia noelle noemi noemie
      nohely nola nolia nolie noma nona nonie nora norah noreen norene noreta noretta norine norita norma nova novella nya
      nyah nyasia nyla nylah nyree octa octavia octavie oda odalis odalys odelia odessa odile ofelia ola olene oleta
      olevia olga olinda olive olivia olivine olympia oma omie ona oneida oneta onie onnie opal opha ophelia orah oralia
      orelia orene orilla orlena orma orpha orra osa otelia ottie ottilia ottilie ouida ova ozella paige pairlee paityn
      pallie paloma pam pamala pamela pamelia pamella pansy paola paralee parthenia patience patrica patrice patricia
      patsy patti pattie patty paula pauletta paulette paulina pauline payten pearl pearla pearle pearlene pearlie
      pearline pearly peggie peggy penelope penni pennie penny perla permelia petra phebe pheobe philomena philomene
      phoebe phylicia phylis phyliss phyllis pinkie pluma pollie polly porsche porsha portia precious pricilla princess
      priscila priscilla prudence prudie qiana queen queenie quiana rachael racheal rachel rachelle racquel rae raegan
      raelynn rafaela ragna raina ramona randi raquel rashida raven rayna rayne reanna reatha reba rebeca rebecca rebekah
      regena regenia regina rella rena renada renae renata renea renee renita ressie reta retha retta rettie reva rhea
      rheta rhianna rhiannon rhoda rhona rhonda rianna richelle rihanna rikki rilla rillie rinda risa rita riya robbin
      roberta robyn rochelle rocio roena rolanda roma romaine romona rona ronda roni ronna rosa rosabelle rosalee rosalia
      rosalie rosalind rosalinda rosaline rosalyn rosamond rosann rosanna rosanne rosaria rose roseann roseanna roseanne
      rosella roselyn rosemarie rosemary rosena rosetta rosey rosia rosie rosina rosita roslyn rossie rosy rowena roxana
      roxane roxann roxanna roxanne roxie roxy rozanne rozella rubi rubie ruby rubye ruie ruth rutha ruthann ruthanne
      ruthe ruthie ryann rylee ryleigh rylie sabina sabra sabrina sade sadie sadye saige salena salina sallie sally salma
      salome samantha samara samatha samira sanaa sanai sandi sandie sandra saniya saniyah sanjuana sanjuanita sannie
      santina sara sarah sarahi sarai sariah sarina sarita sarrah sasha saundra savana savanah savanna savannah savilla
      scarlet scarlett sebrina selah selena selene selina selma senora serena serenity serina shae shaina shakira shalon
      shalonda shameka shamika shana shanae shanda shaneka shanell shanelle shanequa shani shania shanice shaniece shanika
      shaniqua shanita shaniya shanna shannan shannen shanta shante shantel shantell shaquana shaquita shara shardae
      sharday sharde sharee sharen shari sharita sharla sharleen sharlene sharon sharonda sharron sharyl sharyn shasta
      shauna shaunna shavon shavonne shawanda shawna shawnda shawnee shawnna shawnte shayla shaylee shayna sheena sheila
      sheilah shelba shelbi shelbie shelia shelley shelli shellie shelly shelva shelvia shelvie shena shenna sheree sheri
      sherie sherilyn sherita sherlyn sheron sherree sherri sherrie sherry sherryl sheryl sheryll sheyla shianne shiela
      shiloh shirl shirlee shirleen shirlene shirley shirleyann shirlie shona shonda shonna shreya shyann shyanne shyla
      sibbie sibyl siddie siena sienna sierra signe sigrid silvia simona simone sina siobhan sister sky skye skyla socorro
      sofia sondra sonia sonja sonji sonya sophia sophie sophronia stacey staci stacia stacie starla stasia stefani
      stefanie stella stephaine stephani stephania stephanie stephany stephenie stormy sudie sue suellen sula summer sunny
      sunshine susan susana susann susanna susannah susanne susie sussie suzan suzann suzanna suzanne suzette suzie suzy
      sybil sybilla syble sydell sydnee sydni sydnie sylvania sylvia symone syreeta tabatha tabetha tabitha taina taja
      takisha talia taliyah tamala tamara tamatha tambra tameka tamekia tamela tamera tami tamia tamica tamie tamika
      tamiko tamisha tammi tammie tammy tamra tamya tana tanesha tangela tania tanika tanisha taniya taniyah tanja tanya
      tara tarah tarsha taryn tasha tashina tasia tatia tatiana tatianna tatyana tatyanna tawana tawanda tawanna tawny
      tawnya taya tayla tayler teela teena tempie tena tenika tenisha tennessee tennie tennille tera teresa terese teressa
      teri terra terri terrie tess tessa tessie texanna texas texie thalia thea theda thekla thelma theodocia theodora
      theodosia theola theresa therese theresia theta thomasina thora thresa thursa thyra tia tiana tianna tiara tiarra
      tiera tierra tiesha tiffani tiffanie tiffany tilda tilla tillie tina tiney tinie tinnie tiny tisha tishie tobi
      toccara tomasa tomeka tomika tonda toni tonia tonja tonya tori torie torrie tosha toshiko towanda toya tracee tracey
      traci tracie treena trena tresa tressa tressie treva tricia trilby trina trinity trish trisha trista trudi trudie
      trudy trula tula twila twyla tyesha tyra ula una unique ura ursula vada valarie valentina valeria valerie valery
      valinda vallie valorie vanesa vanessa vannie vashti vassie veda velda velia velma velva velvet vena venessa venie
      venita vennie venus veola vera verda verdie verena vergie verla verlene verlie verna vernell vernelle vernetta
      vernice vernita verona veronica versa versie vertie vessie vesta veta veva vicie vickey vicki vickie vicky victoria
      victorine vicy vida vikki vilma vina vincenza vinie vinnie viola violet violeta violetta violette vira virdie virgia
      virgie virginia viridiana vita viva vivian viviana vivien vivienne vlasta vonda vonetta vonnie wanda waneta wanita
      wava wendi wendy whitney wilda wilhelmina wilhelmine willa willene willia williemae willodean willow wilma windy
      winifred winnie winnifred winona wynona xena ximena xiomara yadira yahaira yajaira yamilet yamilex yareli yaretzi
      yaritza yasmeen yasmin yasmine yazmin yesenia yessenia yetta yolanda yolonda yoselin yoshiko yuliana yulisa yulissa
      yuridia yvette yvonne zada zadie zaida zana zandra zaniyah zara zaria zariah zela zelda zelia zella zelma zelpha
      zena zenobia zeta zetta zettie zhane zillah zilpah zilpha zina zita zoa zoe zoey zoie zola zona zora zula`,
    m: `
      aaden aarav aaron ab abb abdiel abdul abe abel abie abner abraham abram ace acie adalberto adam adan add adelard
      adelbert aden adin aditya adlai admiral adolf adolfo adolph adolphus adonis adrain adrian adriel adrien adron aedan
      agustin agustus ah aidan aiden aidyn akeem al alan albert alberto albin albion alcee alcide alden aldo alec aleck
      alejandro alek alessandro alex alexande alexander alexandro alexzander alf alferd alfie alfonse alfonso alfonzo
      alfred alfredo algernon algie algot alijah allan almer almon almus alois alonza alonzo aloys aloysius alpheus
      alphons alphonse alphonso alphonsus alton alvah alvan alvaro alvia alvie alvin alvis alvy amare amarion amasa
      ambrose americo amerigo amir amit amos ananias anatole andre andreas andres andrew andy anfernee angelo angus anibal
      ansel anthony antione antoine anton antone antonio antony antwain antwan antwon arba arbie arch archibald archie
      arden ari aric arjun arlan arland arlen arley arlin arlington arlis arlo arlyn armand armando armin armond arnav
      arne arnie arnold arnoldo arnulfo aron arron arsenio art arther arthor arthur arturo arvel arvid arvil arvin arvo
      aryan asa atticus attilio aubra audley august augustus aurelio aurthur austen austin austyn auther author authur
      axel ayaan aydan ayden aydin babyboy barney barnie barry bart basil beau ben benito benjaman benjamen benjamin
      benjamine benji benjiman benjman benny bernard bernie bert berton bertram bill billy blaine blake blaze bo bob bobby
      boysie brad braden bradley bradly bradyn braeden braedon braiden brain brandan branden brandin brandon brandyn
      braulio braxton brayan brayden braydon braylen braylon brendan brenden brendon brennen brennon brent brenton bret
      brett brian brody bruce bryan bryce brycen bryon bryson bryton bud buddie buddy buford burl burnie buster butch
      byron cade caden cael caiden cal cale caleb calvin camden cameron camren camron carl carleton carlo carlos carlton
      carlyle carmelo carmine cary casimer casimir cassius cayden cedric cedrick cesar ceylon chad chadd chadrick chaim
      chalmer chance charles charley charlie charls charly chas chase chauncey chauncy chaz chester chet chip christian
      christop christoper christopher chuck cicero clabe clair clarance clarence clarnce claud claude claudius clayton
      clearence cleave clell clem clement cleon cletus cleve cleveland clide cliff clifford clifton clint clinton clive
      clovis cloyd clyde coby codey codi codie cody colby coleton colin collin colonel colt colten colton columbus connor
      conor conrad constantine corey cornelious cornelius cory coty coy craig cris cristian cristobal cristofer cristopher
      curt curtis cyril cyrus dakoda dakotah dale dallas dallin dalton dalvin damarcus damari damarion dameon damian
      damien damion damon damond dan dandre dane danial daniel dannie danniel danny dante daquan darell daren darien darin
      dario darion darius darl darnell darold daron darrel darrell darren darrian darrick darrien darrin darrion darrius
      darron darry darryl darryle darryll darryn darvin darwin darwyn daryl daryle daryn dashawn daunte davante dave
      davian david davin davion davon davonta davonte dax daxton dayton dean deandre deangelo deante declan dedric deion
      dejon dejuan del delbert delmar delmas delmer delmus delos delton delvin delwin demarcus demario demarion demetri
      demetric demetrios demetrius demond denis dennie dennis denver denzel denzell denzil deon deondre deonta deontae
      deonte dequan derald dereck derek dereon deric derick derik derl deron derrek derrell derrick derwin deryl desean
      deshaun deshawn desi desmond destin destry devante deven devonta devontae devonte deward dewayne dewey dexter dick
      dickie diego dijon dillan dimitri dimitrios dink dino dion dionte dirk doc dock dolphus domenic domenick domingo
      dominic dominick dominik don donaciano donal donald donavan donavon dondre donell donn donnell donny donta dontae
      donte dorian doug douglas draven drew duane duard durward durwood dustan dustin duwayne dwain dwaine dwane dwayne
      dwight dwyane dylan dyllan dylon ean earl earle earlie earnest ebb ebbie eben ed edd eddie edgar edgardo edison
      edmon edmond edmund edsel eduardo edw edward edwardo edwin efrain efrem efren einar eino elbert elbridge elby elden
      eldon eldred elex eli elian elias elie eliezer eliga eligah elige elihu elijah eliot eliseo elizah elliot ellsworth
      ellwood elmer elmo elon elonzo eloy elroy elton elvin elvis elwin elwood elwyn elza elzie emanuel emery emil emile
      emiliano emilio emit emmanuel emmet emmett emmit emmitt emory enoch enrico enrique enzo ephraim ephram ephriam
      erasmo erasmus erastus eric erich erick erik erle erling ernest ernesto ernie errol ervin erwin esequiel esley
      esteban estel estevan eston ethan ethelbert ethen eugene evan evander everet everett everette evert evertt ezekiel
      ezequiel ezra fabian faron fate fayette felipe felix ferd ferdinand fernand fernando festus fidel fidencio finis
      flem florian floyd foch forest forrest fount francesco francis francisco frank franklin franklyn fred freddy
      frederic frederick fredie fredric fredrick fredy gabe gabriel gael gaetano gage gaige galen garett garfield garland
      garold garret garry garth gary gauge gaven gavin gavyn gaylen gaylon gaylord gearld genaro gene general geo geoff
      geoffrey george geovanni gerald gerard gerardo gerhard gerold gerrit giancarlo gianni gilbert gilberto gino giovani
      giovanni giovanny giuseppe glen glendon glenn glenwood gonzalo gordon grady granville grayling greg gregg greggory
      gregorio gregory greyson grover guillermo gunnar gunner gus guss gust gustaf gustav gustave gustavo gustavus guy
      haiden hakeem hal hamp hamza hank hans harlan harland harlen harlie harold harry harve harvey harvie harvy heber
      hector henery henry herbert heriberto herman hermon hernan herschel hershel hershell hezekiah hezzie hideo hiram
      hiroshi hjalmar hjalmer hobart hobert homer horace horacio horatio hosea hosie hosteen howard hubert hugh hughie
      hugo humberto hurbert hyman hyrum ian ignacio ignatius ike illya imanol immanuel ira irl irven irvin irving isaac
      isadore isai isaiah isaias ishaan isiah isidor isidore isidro ismael israel issac ivan iver ivor izaiah izayah
      jabari jabez jace jack jacky jacob jadiel jadon jaeden jaheem jaheim jahiem jahir jair jairo jajuan jake jakob
      jakobe jaleel jalen jalon jamaal jamal jamar jamarcus jamari jamarion jame jameel jamel james jamey jamil jamin
      jamir jaquan jarad jared jaren jaret jarett jarod jaron jarrad jarred jarret jarrod jase jasen jasiah jason jasper
      javen javier javion javon javonte jax jaxon jaxson jay jayce jaydan jaydin jaydon jaylan jaylen jaylon jaymes jayson
      jayvion jayvon jeb jed jedediah jedidiah jeff jefferey jeffery jeffrey jeffry jelani jep jeptha jerad jerald
      jeramiah jeramie jeramy jere jered jerel jereme jeremey jeremiah jeremie jeremy jerimiah jerimy jermain jermaine
      jermey jerod jerold jerome jeromy jerrad jerrel jerrell jerrod jerrold jerry jess jesse jessy jesus jethro jevon jim
      jimmy joaquin joe joel joeseph joesph joey johan johathan john johnathan johnathon johney johnny johnpaul johny jon
      jonah jonas jonatan jonathan jonathon jorden jordi jordon jordy jorge jory jose josef joseluis joseph josephus josh
      joshua joshuah josiah josue jovan jovani jovanni jovanny jovany juan judah jude judson jules julian julio julious
      julius juluis junior junious junius justen justin juston justyn juwan kade kadeem kaden kadin kadyn kaeden kael
      kahlil kai kaiden kaleb kalen kalvin kamden kameron kamren kamron kanye kareem kareen karl karson karter kasen kason
      kavon kazuo keagan keandre keanu keaton keegan kegan keion keith kelan kelby kellan kellen kelvin ken kenji kenneth
      kennith kennth kenny kent kenton keon kermit keshaun keshawn kevan keven kevin kevon keyon keyshawn khalil khari
      khiry kian kieran kieth kinte kip kirk kirt kit kiyoshi knute kobe koby kody kolby kole kolten kolton konner konnor
      korbin kordell korey kory kraig krish kristofer kristoffer kristopher kunta kurt kurtis kwame kyan kylan kyle kyler
      kymani kyree kyson ladarius laddie lafayette lafe lamar lamarcus lamont lance landan landen landon landyn lanny
      laquan laron larry lars latrell laurence lavar lawerence lawrence leamon leander leeroy leif leland lem lemmie
      lemuel len lenard lenny lenord lenwood leo leon leonard leonardo leonce leonel leonidas leopoldo leroy les lester
      levar levern levi levon liam lige lincoln linus linwood lionel lisandro lloyd logan lon lonnie lonny lonzo loran
      loren lorenzo lorin lorne louis lowell loyal loyd luca lucas lucian lucien lucious lucius luigi luis luka lukas luke
      luther lyle lyman lyndon lynwood mac maceo mack mahlon major makai makhi malachi malakai malaki malcolm malik malvin
      manford manuel marc marcel marcelino marcellus marcelo marco marcos marcus margarito mario mark markus marlin marlon
      marquis marquise marshal mart martez marty marvin masao mat mathew matt matteo matthew maurice mauricio maverick max
      maximilian maximillian maximo maximus mearl mekhi mel melville melvin melvyn memphis menachem merl merlin merlyn
      merton mervin mervyn messiah michael michale micheal michial micky miguel miguelangel mikal mike mikel milford
      millard milo milton minoru misael mitch mitchel mohammad moises mont monte montrell monty mordechai mose moses moshe
      murl mychal myles myron najee namon napoleon nasir nat nathan nathanael nathanial nathaniel nathen ned nehemiah neil
      nello nels newt nicholas nicholaus nick nickolas nicky nico nicolas nigel nikhil nikko niko nikolas nils noah noe
      nolan norbert norberto norman normand norval nunzio obie octave octavio octavius odin odis odus offie okey olaf olan
      ole olen olin oliver olof omar omari omarion omer oral oran oren orie orin orion oris orla orland orlando orley orlo
      orrin orson orval orvel orvil orville osbaldo oscar osvaldo oswaldo otha othel otho otis ottis otto ovid ovila owen
      ozzie pablo parley pasquale patrick paul pedro percy perley pete peter phil philip phillip pink pleas ples pranav
      preston quentin quincy quinten quintin quinton raekwon rafael rafe raheem rahsaan rahul raiden rakeem raleigh ralph
      ramiro ramon randal randall randell randolph randy raoul raphael raquan rashaad rashaan rashad rashawn raul ray
      rayan rayford raymon raymond raymundo raynard rayshawn refugio reggie reginal reginald regis reinaldo reino reuben
      reubin rex reynaldo reynold rhett rhys ricardo richard rick rickey rickie ricky rigoberto rishi river rob robby
      robert roberto robt rocco rocky rod roderic roderick rodger rodney rodolfo rodrick rodrigo roel rogelio roger rohan
      roland rolando rolla rolland rollie rollin romello romeo romie ron ronal ronald ronaldo rondal ronin ronnie ronny
      roosevelt rory rosco roscoe rosendo rosevelt roswell roy royal royce rube ruben rudolf rudolfo rudolph rudy rueben
      ruffus rufus rupert russel russell rusty ryan ryker rylan ryley ryne sabastian sal salvador salvatore sam samie
      samir sammy samual samuel santino saul saverio savion savon scot scott scottie scotty seamus sean sebastian sedrick
      selmer semaj sergio seth shad shamar shane shaquan shaquille shaun shayne sheldon shemar shep shon shyheim sid
      sigmund sigurd silas silvio sim simeon simmie sincere skip sol sonny soren spenser stan stanley stefan stephan
      stephen stephon sterling stevan steve steven stonewall stuart sylvan sylvanus sylvester tab tad tahj talan talen
      talmadge talmage talon tanner tarik tariq tatsuo taurean taurus tavaris tavian tavion tavon tayshaun ted teddie
      teddy telly terance terence terrance terrence tevin tex thad thaddeus theadore thedore theodis theodore theophile
      theron thomas thorwald thos thurman tim timmie timmothy timmy timothy tobe tod todd toivo tollie tom tomas tomie
      tommy tony torey toriano tory toshio trace trae travis travon trayvon tre tremayne trent trenten trenton trever
      trevin trevion trevon trevor trey treyton treyvon tristan tristen tristian tristin triston troy trumaine truman
      trystan ty tyler tylor tyquan tyreek tyreese tyrek tyreke tyrel tyrell tyrese tyrik tyrin tyriq tyrique tyron tyrone
      tyrus tyshawn ulises ulysses unnamed uriah uriel urijah val van vergil verl verle verlin verlon verlyn vern vernal
      verne verner vernon vester vic vicente victor vince vincent vincenzo virge virgel virgil virgle vito vollie volney
      von waino waldemar waldo wally walter warren waverly wayde waylon waymon wayne weldon wendell wes wesley westley
      whit wilber wilbert wilbur wilburn wilford wilfred wilfredo wilfrid wiliam will willaim willam willard william
      willian wilmer wilton windell winfield winford winfred winston wm woodroe woodrow wyatt xander xavier xzavier yaakov
      yadiel yael yahir yair yandel yehuda yoel yosef yoshio yurem zachariah zachary zachery zack zackary zackery zaid
      zaiden zain zaire zakary zander zane zavier zayden zayne zeb zebulon zechariah zed zeke zenas zigmund zollie`,
    fs: `
      adel agness ala alba alvira alwine ama amaya amey amparo anaya angele angeles ansley arietta arra atha bea bebe bell
      bena betha bethel bina blossom brande brea briley brinda cannie caprice caro caron carra carry cathey cena chaney
      cherry cielo cilla cinnamon coletta collette columbia concepcion concha cordella corliss crete cuba dani daniele
      delaney delle dema dionne donia dove dwan easter edie edris ela elia eller else essa estrella etter fallon farah
      felice felicitas flor fonda franc francies gay gemma gillie gladis gracia gwyn hadley hanna hasel hennie illa inger
      ireland ivie iza jann january jaye jeanmarie jennette joline joslyn joye karel karis karren keeley keena kelley
      kenley kennedy kimber kinley kinsey kinsley lady lalla laney lara larue lavelle lemma leone levina liller lillis
      linna loda loree loria loris lovey lovisa lu lucero lulla luna magan mai maida manilla marin marti martine mckenna
      mckenzie medora mena mercy miley miracle modena mora nanna nealy nichol nicola odette olar olena oline oliva oney
      ota paisley palma pandora parlee pepper perri phillis pinkey piper presley regan reina rennie reyna sable sada santa
      sena shandra sharman shatara sherron shira signa sinda sloane soledad somer sommer spring star starr sunday sylva
      tai tari tatum tea tella tisa treasure valencia vara vela vella venice verdell vernia victory villa viney wende
      whitley winter`,
    ms: `
      abbott abdullah abelardo acey acy adams ahmad ahmed alanzo albertus alby alexandre alford alger allen allyn almond
      alonso alston alto alver alwin amado ambers amil amin ammon amon anastacio ancel ancil anders anderson andon andrae
      anson anthoney anwar archer arman armstead arnett arno artis asberry asbury ashby asher atlas audy auguste augustin
      auston autry avon babe baker baldwin ballard banks barnard barnett baron barrett barrie barron bartholomew bartley
      barton bascom baxter bayard beckett beckham bedford bee beecher belton benard benedict bennett benson bentley benton
      berkley berlin bernardo bernhard berry bertrand bilal birt bishop bjorn blain blaise blanchard blane blas bliss
      bluford bode bolden booker boone boris bose boss boston bowman boyce boyd bradford brady branch brandt brannon
      branson brant brantley brennan brice bridger brien brion britton brock broderick brodie brogan bronson brooks brown
      bruno bryant buck budd buel buell bunk burdette buren burgess burk burke burleigh burley burnell burnett burney
      burns burr burrel burrell burt burton bush butler bynum caesar cain calhoun callum cam candido cannon canyon cap
      captain carlisle carnell carroll carsen carson carter cas case cash casimiro cason casper cass caswell cato ceasar
      celestino cephus chace chadwick chalmers champ chancey chancy charle charlton che chesley chin christ christion
      claiborne clark clarke claudio claus clay clemens clemente clemon coen cohen colbert cole coleman coley colie collie
      collier collins collis colon colter colvin commodore con conard conley conner conway coolidge cooper corbett corbin
      cordaro cordell cordero cornel cornell corry cortez corwin cosmo council courtland crawford creed crockett cullen
      curley curtiss dabney dangelo dann daulton davey davie davis davy dawson dayne deacon deane dedrick deegan deforest
      delano delphin demarco demian demonte dempsey denny denton devaughn dewitt diallo dillard dillion dillon dionicio
      dixon doctor doll dolph domenico donat donato donovan dorman dorr dorsey doss douglass dow doyle dozier drake drury
      dudley duff duke duncan durell durrell earley early easton ebenezer eber ebert eddy edson egbert elam elder eldridge
      elgin elick ell ellery elliott ellis ellison elmore elsworth ely elzy emett emmons emry encarnacion ennis enos
      epifanio erby erland ernst erving esau esco esker essex estes estill eugenio eusebio eustace evans ewald ewart ewell
      ewin ewing ezell ezzard farrell farris faustino fed federico felton fenton ferman ferrell ferris fielding finn
      finnegan firman fisher fitzgerald fitzhugh fleet fleming fletcher flint florencio florentino ford foster foy franco
      franz frazier freeman fremont french friend fritz fuller fulton furman gaines gaither gannon gardner garey garner
      garrett garrick garrison garvin gasper gaston geary gee gennaro geno geraldo gerhardt german gibson gideon gifford
      gil giles gilford gilman gilmer gilmore gladstone glover glynn godfrey goebel gorden gorge gottlieb governor grafton
      graham grant graves gray graydon grayson green greene griffin griffith grove guido guilford gurney guthrie haden
      hakim halbert hale hall halsey ham hamilton hampton handy hansel hansford hanson harden hardie hardin harding hardy
      harl harlon harlow harm harman harmon harrell harrie harris harrison harrold hart hartley hartwell hasan haskell
      hassan hayes hays hayward haywood hazen heath hebert helmer hence henderson henri herb hermann hervey heyward
      hilario hilbert hill hillard hillery hilliard hilmer hilton hobson hoke holden holland hollis holmes hoover horton
      houston howell hoy hoyt hubbard hudson huey hughes hughey humphrey hung hunt hunter hurley huston huy hymen ibrahim
      ignatz ingram irvine irwin isaak isam isham ishmael isom isreal iverson ivey jabbar jackson jacoby jacques jacquez
      jagger jameson jamison jaquez jarrell jarrett jarvis jefferson jemal jennings jens jessee jett jiles job jobe
      johnson jones judd judge julien justus kale kane karim kash keenan keenen keifer kelton kem kenan kendell kendrick
      kennard kenney kenyon kerwin khalid kiefer kiel killian kimball king kingston kipp kirby knox koda koen lambert
      lamonte landin lane lark larkin lary laurance lawrance lawson lawton lawyer layne layton lazaro le leandro leighton
      lemon lennon lenon leopold less levie levin levy lew lewis lex lilburn lillard lim lindbergh lindell linden link
      linn linton linzy lish lisle liston little littleton llewellyn lone loney long lorenz loring lott lovell lovett loy
      luc luciano lucio lucky ludwig lum luster lute lydell macarthur mace madden maddox mal malcom male manley manly
      manning mansfield manson marcello marchello mariano marius markel markell marland marques marquez marrion marsh
      marshall martell martin mason mateo math mathews mathias matias matthias mauro maury maxim maxwell maynard mayo
      mcarthur mckinley melbourne melton mercer merrill merritt merwin metro meyer michel mikeal mikhail milan milas
      milburn miles miller mills miner minor mitchell moe mohamed mohammed monroe montel montgomery moody morris mortimer
      morton muhammad murdock murphy murray murry mustafa myer mykel nash neal needham neely nelson nery nestor nevin
      newell newman newton nicklaus nikolai nile niles nim noble nolen norris north norton norwood oakley obe obed oddie
      ogden oland oley oneal orange orlin orren orris orvin orvis osborn osborne oswald ott owens page palmer park parker
      parrish pascal pate patric paulo paxton pearley percival pernell perry pershing philo pierce pierre pinkney pleasant
      plummer polk porfirio porter posey powell pratt prentice prentiss press price primus prince prosper pryor purl quint
      rahn ramsey rance rand randel randle randolf ransom ras rasheed rayburn rayfield reason red redden redmond reece
      reed reid reinhold remington renaldo renard reno rexford rey reyes reynolds rian ricci rice rich richie richmond
      rico ridge ritchie robb robley roby rock roddy roe rogers rolf roll rollo roman rome ronan ross rowland rubin ruel
      ruffin rush russ rustin rutherford ryder ryland saint salomon sampson samson sanders sanford santiago santo santos
      sawyer schley schuyler seaborn seldon seneca severo severt seward seymour shade shafter shan sharif shedrick shelton
      shepherd sherman sherwin sherwood shoji sie silver silvester simon simpson sing slade smith soloman solomon solon
      son spencer spurgeon squire stafford stanford stanislaus stanton starling stetson steward stewart stone stoney storm
      sullivan sumner syed taft taj tal tallie tandy tate tavares tegan terell terrell terrill therman thompson thor
      thornton thurlow thurston tilden tillman tilman tito titus tobias tobie tobin tolbert toma toney torrance torrence
      torrey torry toy tremaine tripp true tuan tucker turner tye tyree tyson urban valentin valentine valentino vance
      vander vashon vaughn vere vick victoriano vidal vinson vinton wade walker wallace walt walton ward wardell warner
      wash washington watson watt wayland wayman weaver webb webster wellington wells welton wendel wenzel werner wess
      west weston wheeler wiley wilhelm wilkie williams williard willis willy wilson wing winthrop winton wirt wong wood
      woodie woodson woody worley worth wright wylie wyman yancy yee york young yusuf zeno`,
    u: `
      addison alexis allie alpha alva amari andra angel ardell ariel arlie armani artie ashton aubrey audie augustine
      avery baby bennie beryl billie bobbie brook burnice carmen carrol casey cecil channing chris clare claudie cleo
      cortney dakota dana darian dee devan devin devon devyn dominique dominque donnie dusty elisha erie fay frankie
      freddie gale garnet garnett gerry guadalupe harley hayden hollie infant ivory ivy jackie jaden jadyn jaiden jaidyn
      jaime jamie jammie jan jayden jaylin jayme jeffie jessie jewel jewell jimmie jodie jody johnie johnnie jonnie jordan
      jule kamari kasey kayden kelly kendal kendall kenyatta kerry kris kristian lacy lannie lashawn lavern laverne lavon
      lennie lesley leslie lindy lonie lorenza louie lupe luverne lynn mannie marion marlyn maxie merle micah mickey
      montana montie nakia noel ocie odie olie ollie ora orrie osie ossie ozell ozie paris pat payton peyton phoenix
      reagan rene ricki robbie robin sage sammie sandy shannon shanon shawn shelby sidney skylar skyler stacy stevie
      sydney teagan terry theo toby tommie tracy unknown vernie willie zion`,
  };
  // GENERATED:NAME_SEX end
  const NAME_SEX = new Map(), NAME_GIVEN = new Set();
  for (const k of Object.keys(NAME_SEX_DATA)) for (const w of NAME_SEX_DATA[k].split(/\s+/)) { if (!w) continue; if (k !== 'u') NAME_SEX.set(w, k[0]); if (k.length === 1) NAME_GIVEN.add(w); }
  // the union, for code that wants every made-up organization
  const FAKE_ORGS = Object.values(FAKE_ORG_POOLS).flat();

  // accents folded away for lexicon lookups: Nguyễn → nguyen, Bríd → brid, Đặng → dang
  const fold = (w) => String(w).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const FIRST_SET = setOf(FIRST_NAMES);
  const LAST_SET = setOf(SURNAMES);
  const CITY_SET = setOf(US_CITIES);
  const RELATION_SET = setOf(RELATION_CUES);
  const HONORIFIC_SET = setOf(HONORIFICS.map((h) => h.replace(/\.$/, '')));
  const CREDENTIAL_SET = setOf(CREDENTIALS);
  const ORG_SUFFIX_SET = setOf(ORG_SUFFIXES);
  const ORG_NAMEWORD_SET = setOf(ORG_NAMEWORDS);
  const GEO_SUFFIX_SET = setOf(GEO_SUFFIXES);
  const ORG_PREFIX_SET = setOf(ORG_PREFIXES);
  const PLACE_PREFIX_SET = setOf(PLACE_PREFIXES);
  const GREETING_SET = setOf(GREETINGS);
  const LANGUAGE_SET = setOf(LANGUAGES);
  // Number words for written-out ages (ninety-two year old).
  const ONES_WORDS = words(`one two three four five six seven eight nine`);
  const CA_PROVINCES = { ON: 'Ontario', QC: 'Quebec', BC: 'British Columbia', AB: 'Alberta', MB: 'Manitoba', SK: 'Saskatchewan', NS: 'Nova Scotia', NB: 'New Brunswick', PE: 'Prince Edward Island', NL: 'Newfoundland' };
  const STATE_ABBR_SET = new Set([...Object.keys(US_STATES), ...Object.keys(CA_PROVINCES)]);
  const STATE_NAME_SET = setOf([...Object.values(US_STATES), ...Object.values(CA_PROVINCES)]);

  // Large lexicon (src/biglex.js, built from Census/SSA/public lists). Tiers: strong names may stand alone;
  // weak names need a second name token or a cue; a name that is also an English word needs a cue unless the
  // curated lists already treat it as a clear name (Smith, Aaron).
  const B = BIG || { S2: new Set(), S1: new Set(), F2: new Set(), F1: new Set(), EN: new Set() };
  const curatedClear = (k) => (FIRST_SET.has(k) || LAST_SET.has(k)) && !AMBIGUOUS.has(k);
  const anyTier = (k) => B.S2.has(k) || B.S1.has(k) || B.F2.has(k) || B.F1.has(k);
  const strongTier = (k) => B.S2.has(k) || B.F2.has(k);
  const keyOf = (w) => { const k = String(w).toLowerCase(); return (LAST_SET.has(k) || FIRST_SET.has(k) || anyTier(k)) ? k : fold(w); };
  const isEnglishWord = (w) => B.EN.has(fold(w));
  // strong: curated clear names, Census surnames with 1000+ bearers, SSA top-1000 first names (unless curated as word-names)
  const strongName = (k) => curatedClear(k) || (strongTier(k) && !AMBIGUOUS.has(k));
  // ambiguous: curated word-names, or a weak-tier name that is also an ordinary English word
  const ambiguousName = (k) => AMBIGUOUS.has(k) || (!strongName(k) && anyTier(k) && B.EN.has(k));
  return {
    BIG: B, isEnglishWord,
    // the 275k-word dictionary (Bloom filter): ordinary and medical words, plus simple inflections
    isDictWord: (w) => { if (!DICT) return false; const k = fold(w); if (DICT.has(k)) return true; const stems = [k.replace(/'s$/, ''), k.replace(/s$/, ''), k.replace(/es$/, ''), k.replace(/ed$/, ''), k.replace(/ed$/, 'e'), k.replace(/ing$/, ''), k.replace(/ing$/, 'e'), k.replace(/ly$/, '')]; return stems.some((x) => x !== k && x.length >= 3 && DICT.has(x)); },
    // strong: safe to tag on its own (curated lists, Census >= 1000 bearers, SSA top-1000 names)
    isStrongName: (w) => strongName(keyOf(w)),
    isCuratedName: (w) => { const k = String(w).toLowerCase(); return FIRST_SET.has(k) || LAST_SET.has(k) || FIRST_SET.has(fold(w)) || LAST_SET.has(fold(w)); },
    // anchor: a name that can carry a run on its own. Curated clear names (Smith) or strong names that are not
    // ordinary English words (Halvorsen). "Garden", "Lodge", "Strong" are strong surnames but never anchors.
    isAnchorName: (w) => { const k = keyOf(w); return curatedClear(k) || (strongTier(k) && !AMBIGUOUS.has(k) && !B.EN.has(k)); },
    // weak: only with a second name token or a cue (rare surnames, list-only first names, word-names)
    isWeakName: (w) => { const k = keyOf(w); return (anyTier(k) || FIRST_SET.has(k) || LAST_SET.has(k)) && !strongName(k); },
    FIRST_NAMES, SURNAMES, AMBIGUOUS, CLINICAL_ALLOWLIST, RELATION_CUES, HONORIFICS,
    CREDENTIALS, ORG_SUFFIXES, US_STATES, US_CITIES, HOLDOUT_FIRST, HOLDOUT_LAST,
    FAKE_FIRST, FAKE_FIRST_F, FAKE_FIRST_M, FAKE_FEMALE, FAKE_MALE, FAKE_LAST, FAKE_ORGS, FAKE_CITIES, FAKE_STREETS, FAKE_ORG_POOLS, FAKE_ORG_STEMS, LOCAL_ORG_KIND,
    FAKE_SAINTS, CITY_KEEP_PREFIX, CITY_KEEP_SUFFIX, NAME_SEX, NAME_GIVEN,
    FIRST_SET, LAST_SET, CITY_SET, RELATION_SET, HONORIFIC_SET, CREDENTIAL_SET,
    ORG_SUFFIX_SET, ORG_NAMEWORDS, ORG_NAMEWORD_SET, STATE_ABBR_SET, STATE_NAME_SET, CA_PROVINCES,
    GEO_SUFFIXES, GEO_SUFFIX_SET, PLACE_PREFIXES, PLACE_PREFIX_SET, ONES_WORDS, ORG_PREFIXES, ORG_PREFIX_SET,
    NICKNAMES, EPONYM_FOLLOW, LOCAL_ORGS, LOCAL_ORG_SET, GREETINGS, GREETING_SET, LANGUAGES, LANGUAGE_SET,
    nicknamesOf: (w) => NICKNAMES[w.toLowerCase()] || [],
    isFirstName: (w) => FIRST_SET.has(w.toLowerCase()) || FIRST_SET.has(fold(w)) || B.F2.has(keyOf(w)) || B.F1.has(keyOf(w)),
    isSurname: (w) => LAST_SET.has(w.toLowerCase()) || LAST_SET.has(fold(w)) || B.S2.has(keyOf(w)) || B.S1.has(keyOf(w)),
    fold,
    // ambiguous: curated word-names, plus any big-lexicon name that is also an English word and not curated as clear
    isAmbiguous: (w) => ambiguousName(keyOf(w)),
    isCuratedAmbiguous: (w) => AMBIGUOUS.has(String(w).toLowerCase()),
    isClinical: (w) => CLINICAL_ALLOWLIST.has(w.toLowerCase().replace(/[’']s$/, '')) || CLINICAL_ALLOWLIST.has(w.toLowerCase()),
  };
});
