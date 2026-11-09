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
  // Surrogate pools. Disjoint from everything above would be ideal but the
  // generator also excludes anything that appears in the document being processed.
  const FAKE_FIRST = words(`
    Alden Bettina Caspian Delia Everett Flora Gideon Hollis Ivo Juniper Leander Maren Nils Orla Perrin Quill
    Rosalie Soren Tamsin Ulric Verity Xander Yara Zeph Ansel Brigid Cato Dahlia Elio Greer Idris Jolene Kerrigan
    Lowell Mirabel Odette Pascal Quinlan Rhoswen Sorrel Thora Umber Wilder Xanthe Yvaine Zane Adair Blythe Corin
    Dorian Elowen Faye Garnet Inigo Jessamine Kieran Merritt Neve Oren Ansgar Cosima Esme Gwendolen Hesper Ilsa
    Jory Keturah Linnea Nerys Oswin Petra Quentin Rafferty Saskia Tobiah Una Vesper Wendeline Yannick Zelie Aurelio
    Beatrix Cyprian Emrys Gilda Alaric Brunhild Cedric Dagny Eberhard Godfrey Hedwig Ingram Jocasta Kasimir
    Leopoldine Marius Nerissa Octavian Philomena Quintus Romilly Sigrid Thaddea Ulrika Valentin Wilhelmine Ximena
    Yolande Zbigniew Anselma Bertram Clothilde Eulalia Fabrice Gisela Isolde Jerome Kristof Lucasta
    Morwenna Noelle Peregrine Quenild Rosamund Sylvester Theodora Urban Vivienne Winthrop Yseult Zephyrine
    Amadeus Benedikta Drusilla Elspeth Florentin Guinevere Hyacinth Jemima Kasper
    Melisande Nikolaus Oriel Persis Reinhold Seraphine Tancred Ursula Vitus Wolfram Yorick Zinnia Ambrosine
    Barnabas Clemency Dorothea Ephraim Fulvia Gerhardt Honorine Ivor Josiane Konstantin Marcelline
    Nathanael Ottavia Radegund Sebastienne Tiberius Ulysse Valery Wenceslas Zenobia Aurelian
    Bellamy Dulcie Evander Fiorella Gaspard Hildegard Isidore Jolyon Kerensa Maud Norbert Olympe
    Percival Rhiannon Sabina Torvald Udo Veronika Wystan Zora Anneke Bram Cordelia Dimitra Ewan Freya Gunnar Hanne
  `);
  const FAKE_LAST = words(`
    Ashgrove Brightwell Calloway Dunmore Ellery Fairchild Greenhalgh Holloway Jessop Kingsley Lockhart Marlowe
    Northcote Oakes Pembridge Quayle Ravenscroft Stanmore Thorne Underhill Vance Westbrook Yardley Aldridge
    Blackwood Carrow Danforth Eastwick Farrow Glenmore Hartwell Islington Jarrow Kestrel Lindell Moorcroft
    Nightingale Orchardson Prescott Quenby Redfern Sallow Tennant Upton Vickery Whitmore Yeoman Ashby Bramwell
    Colfax Dunstable Everleigh Fenwick Grantham Hollingsworth Iredale Jessamy Kittredge Lanchester Mortlake
    Nethercott Oxley Pennington Quarrington Rowntree Selwyn Thackeray Umberfield Vanbrugh Wakefield Yelverton
    Ashdown Beaumont Crewe Abbotsley Barrowcliffe Chadwell Dalrymple Elphinstone Gainsford Hatherley
    Ingleby Jocelyn Kenworthy Lanyon Marchbank Netherby Ormerod Pelham Quilliam Ridgeway Sandringham Tollemache
    Uppingham Verlander Wentworth Yaxley Ambleside Birkdale Cottingham Dovercourt Egerton Fulwood Garsington
    Hurlingham Ivinghoe Jevington Kelmscott Lydgate Melbury Northallerton Oakhurst Petworth Quantock Rydal
    Stavely Tredegar Upwell Vexley Wimpole Yardwick Allerton Bexley Clavering Dunsford Elmhurst Fairlie Godolphin
    Harcourt Inchbald Jerningham Kirkbride Lancing Mowbray Nunnery Orwell Pelletier Quincey Rosedale Silvester
    Tremaine Ulverston Vanterpol Wrexham Yelland Ashcombe Brindley Cavendish Doverley Eskdale Fenchurch Gresham
    Hawkesbury Ingleton Josselin Kenilworth Lindisfarne Marchmont Newbold Osterley Pickering Quenington Ravensworth
    Shelbourne Thirlwall Urquhart Vanstone Wethersfield Yellowley Ambridge Blakeney Charlbury Dunwich Elsworth
    Fontwell Gillingham Haverstock Ickworth Jesmond Kingswood Lambourne Milbrook Nettlebed Oxenford Pangbourne
    Quorn Ramsbury Stoneleigh Tilbrook Ullswater Verwood Whitacre Yarrowby Amherley Bilsdale Cressley Dunholme
    Ettrick Fernleigh Gatcombe Hartsby Ingoldsby Jarvisley Keswick Lavenham Marwood Nethershaw Ottery Penhallow
    Quarmby Rushbrook Sedgwick Tarrant Underwood Vanbury Wyndham Yeovil Ashwell Bradworthy Cheverell Draycott
    Ellingham Farncombe Glynde Hambleden Iffley Kelsall Lisle Marlston Norbury Ottershaw Pyecombe Ramsgate Stanwick
    Thornleigh Upcott Villiers Wrayburn Yateley Ashperton Boscastle Chilcombe Dunkeswell Exford Fowey Godrevy Hallsands
  `);
  const FAKE_ORGS = words(`
    Riverside|Medical|Center Lakeview|Oncology|Associates Northgate|Regional|Hospital
    Pinecrest|Cancer|Institute Harborview|Clinic Meadowbrook|Health Stonebridge|Hospice
    Cedar|Hills|Infusion|Center Westfield|Memorial|Hospital Brookhaven|Hematology
    Summit|Ridge|Medical|Group Oakdale|Community|Hospital Fairmont|Imaging
    Silverlake|Pharmacy Elmwood|Home|Care Clearwater|University|Hospital Greywater|Industries
    Tallmadge|Foods Halvorsen|Motors Brightwater|Insurance Ironbridge|Church Hillmere|Temple
  `).map((s) => s.replace(/\|/g, ' '));
  const FAKE_CITIES = words(`Ashford Brimley Coldwater Dunbar Eastmere Fallbrook Glenhaven Hartsfield Ivydale Kessler Larkspur Millbrook Northfield Oakridge Pinehurst Quarryville Redmond Stonehaven Thornbury Wexley`);

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
    FAKE_FIRST, FAKE_LAST, FAKE_ORGS, FAKE_CITIES,
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
