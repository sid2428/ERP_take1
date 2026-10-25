-- 043 · T3-3 Seed: five units per course (182 courses).
-- Depends on: 042 (course_unit). Theory courses get real unit titles; labs and tutorials (lecture_hrs = 0)
-- get a standard five-part layout named after the course.
-- planned_lectures per unit: 4 lecture hrs/week -> 11, 3 lecture hrs/week -> 9, lab -> 4, tutorial -> 3.
-- Safe to re-run: units that already exist are left alone. Fails loudly if any course ends up without 5 units.
SET search_path = erp, public;

WITH theory(code, titles) AS (VALUES
-- AIDS
('AIDS111','Intelligent agents and problem solving|Uninformed and informed search|Logic and knowledge representation|Probabilistic reasoning|Planning, learning and AI applications'),
('AIDS121','Data science lifecycle and tools|Data collection and cleaning|Exploratory data analysis|Statistical inference basics|Visualization and communication'),
('AIDS131','Python basics and control flow|Functions, modules and OOP|NumPy and array computing|Pandas for data wrangling|Visualization with Matplotlib'),
('AIDS211','Probability axioms and random variables|Distributions and expectation|Joint distributions and Bayes rule|Estimation and hypothesis testing|Regression and statistical learning'),
('AIDS221','Data preprocessing and warehousing basics|Frequent patterns and association rules|Classification techniques|Clustering methods|Outlier detection and mining trends'),
('AIDS231','Relational model and SQL|Normalization and transactions|Data warehouse architecture|OLAP and dimensional modeling|ETL and warehouse design'),
('AIDS311','Perceptrons and feedforward networks|Backpropagation and optimization|Convolutional networks|Recurrent networks and sequence models|Regularization and modern architectures'),
('AIDS321','Text processing and language models|Syntax and parsing|Semantics and word embeddings|Sequence models and transformers|NLP applications'),
('AIDS331','Image formation and filtering|Features and edge detection|Image segmentation|Object detection and recognition|Motion, 3D vision and deep vision'),
('AIDS411','MDPs and the reinforcement learning problem|Dynamic programming|Monte Carlo and temporal difference learning|Function approximation and deep RL|Policy gradients and applications'),
('AIDS415','Generative modeling foundations|Autoencoders and VAEs|Generative adversarial networks|Diffusion models|Transformers and prompt-based generation'),
('AIDS421','Big data concepts and Hadoop|MapReduce and HDFS|Spark and in-memory processing|NoSQL stores|Streaming and big data pipelines'),
('AIDS425','Semantic web foundations|RDF and ontologies|SPARQL and querying|Graph databases|Knowledge graph construction and embeddings'),
('AIDS431','Foundations of AI ethics|Bias and fairness|Transparency and explainability|Privacy, safety and security|Governance and regulation'),
('AIDS510','Deep network optimization|Advanced CNN architectures|Attention and transformers|Self-supervised learning|Deployment and scaling'),
('AIDS520','Language model foundations|Transformer architecture at scale|Pretraining and fine-tuning|Prompting, retrieval and agents|Evaluation and deployment'),
('AIDS530','Multimodal representation learning|Vision-language models|Audio and speech models|Fusion and alignment techniques|Multimodal applications and evaluation'),
('AIDS540','Machine learning system design|Data and feature pipelines|Training infrastructure|Model serving and monitoring|MLOps and reliability'),
('AIDSH1','The alignment problem|RLHF and preference learning|Robustness and adversarial attacks|Interpretability|Evaluation, red teaming and governance'),
('AIDSH2','Symbolic AI foundations|Neural-symbolic integration|Differentiable reasoning and logic tensor networks|Program synthesis and knowledge injection|Applications and open problems'),
('AIDSO1','What AI is and how it works|Machine learning in daily life|AI in business and industry|Building simple AI projects|Societal impact of AI'),
-- CIVIL
('CIVIL111','Basic surveying and chain survey|Compass and plane table survey|Levelling|Theodolite and traversing|Contouring and modern instruments'),
('CIVIL121','Stones, bricks and tiles|Cement, lime and mortars|Timber, paints and modern materials|Masonry and foundations|Floors, roofs and finishing works'),
('CIVIL131','Stress and strain|Axial loading and elastic constants|Bending moment and shear force|Bending and shear stresses|Torsion, columns and strain energy'),
('CIVIL211','Determinate structures and deflections|Energy methods|Influence lines and moving loads|Indeterminate beams and slope-deflection|Moment distribution and stiffness method'),
('CIVIL221','Fluid properties and statics|Kinematics of flow|Dynamics and Bernoulli equation|Flow through pipes|Open channel flow and dimensional analysis'),
('CIVIL231','Cement and aggregates|Properties of fresh concrete|Hardened concrete properties|Concrete mix design|Special concretes and durability'),
('CIVIL311','Soil properties and classification|Permeability and seepage|Compaction and consolidation|Shear strength|Earth pressure and bearing capacity'),
('CIVIL321','Highway planning and alignment|Geometric design|Pavement materials and design|Traffic engineering|Railway and airport engineering'),
('CIVIL331','Steel properties and design philosophy|Tension members|Compression members|Beams and plate girders|Connections and trusses'),
('CIVIL411','Water demand and sources|Water treatment|Wastewater characteristics and treatment|Solid waste management|Air and noise pollution'),
('CIVIL415','Smart city concepts|Urban infrastructure and mobility|Smart utilities and IoT|Sustainable buildings and energy|Governance and case studies'),
('CIVIL421','Hydrology and precipitation|Runoff and hydrographs|Groundwater hydraulics|Irrigation engineering|Dams and canal structures'),
('CIVIL425','Bridge types and site investigation|Loads on bridges|Design of RCC bridges|Steel and composite bridges|Bearings, substructure and maintenance'),
('CIVIL431','Types of estimates|Quantity estimation of buildings|Rate analysis|Specifications and tendering|Valuation and contracts'),
('CIVIL510','Single degree of freedom systems|Forced vibration and damping|Multi degree of freedom systems|Modal analysis|Seismic response and applications'),
('CIVIL520','Advanced soil behaviour|Stress paths and critical state|Deep foundations|Slope stability|Ground improvement'),
('CIVIL530','Systems analysis concepts|Optimization techniques|Reservoir operation|Water allocation and economics|Flood and drought management'),
('CIVIL540','Project planning and scheduling|CPM and PERT|Resource management|Cost control and safety|Contracts and quality management'),
('CIVILH1','Engineering seismology|Seismic response of structures|Code provisions for seismic design|Ductile detailing|Retrofitting and base isolation'),
('CIVILH2','Urban transport systems|Travel demand modeling|Public transport planning|Traffic management and non-motorized transport|Evaluation and policy'),
('CIVILO1','Hazards and disasters|Risk and vulnerability|Mitigation strategies|Preparedness and response|Recovery and policy framework'),
-- CSE
('CSE111','Introduction to programming and C basics|Control structures|Functions and arrays|Pointers and strings|Structures and file handling'),
('CSE121','Logic and proofs|Sets, relations and functions|Combinatorics|Graph theory|Algebraic structures'),
('CSE131','Number systems and Boolean algebra|Combinational circuits|Sequential circuits|Registers and counters|Memory and programmable logic'),
('CSE211','Arrays and linked lists|Stacks and queues|Trees|Graphs|Searching, sorting and hashing'),
('CSE221','Classes and objects|Inheritance and polymorphism|Exception handling|Templates and generics|I/O streams and collections'),
('CSE231','Basic computer organization|Arithmetic and ALU design|Control unit and microprogramming|Memory hierarchy and cache|Pipelining and I/O organization'),
('CSE311','Algorithm analysis and recurrences|Divide and conquer|Greedy methods|Dynamic programming|Backtracking and NP-completeness'),
('CSE321','OS introduction and processes|CPU scheduling|Synchronization and deadlocks|Memory management|File systems and I/O'),
('CSE331','ER model and relational algebra|SQL|Normalization|Transactions and concurrency|Storage, indexing and recovery'),
('CSE411','Network models and physical layer|Data link layer|Network layer and routing|Transport layer|Application layer protocols'),
('CSE415','Neural network basics|Training deep networks|Convolutional networks|Recurrent networks and LSTMs|Autoencoders and GANs'),
('CSE421','Lexical analysis|Syntax analysis and parsing|Semantic analysis|Intermediate code generation|Optimization and code generation'),
('CSE425','Cloud concepts and service models|Virtualization|Cloud architecture and storage|Cloud security|Cloud platforms and services'),
('CSE431','Introduction and linear models|Classification|Ensemble methods and SVM|Unsupervised learning|Model evaluation and neural network basics'),
('CSE510','Amortized and randomized analysis|Advanced graph algorithms|Network flow|Approximation algorithms|Computational complexity'),
('CSE520','Big data platforms|MapReduce and Spark|Data stream processing|Scalable machine learning|Analytics case studies'),
('CSE530','Security goals and classical cryptography|Symmetric key cryptography|Public key cryptography|Authentication and network security|System and web security'),
('CSE540','Distributed system models|Communication and RPC|Time and coordination|Replication and consistency|Fault tolerance and distributed storage'),
('CSEH1','Failure models and fundamentals|Paxos and Raft|Byzantine fault tolerance|Blockchain consensus|Consensus in practice'),
('CSEH2','Program analysis foundations|Dataflow optimizations|Loop optimizations and parallelism|Register allocation and scheduling|JIT and modern compiler infrastructure'),
('CSEO1','Cyber security fundamentals|Threats and attacks|Cryptography basics|Network and web security|Security policies and cyber law'),
-- EE
('EE111','Circuit laws and network theorems|DC and AC circuit analysis|Resonance and coupled circuits|Transient analysis|Three phase circuits and two-port networks'),
('EE121','Vector calculus and electrostatics|Boundary value problems|Magnetostatics|Time varying fields and Maxwell equations|Wave propagation'),
('EE131','Safety and tools|Wiring and installation|Electrical measuring instruments|Domestic appliances and protection|Earthing and troubleshooting'),
('EE211','Magnetic circuits|Transformers|DC generators|DC motors|Testing of DC machines and transformers'),
('EE221','Diodes and rectifiers|BJT biasing and amplifiers|FET circuits|Feedback and oscillators|Operational amplifiers'),
('EE231','Measurement fundamentals and errors|Analog meters and bridges|Electronic instruments|Transducers and sensors|Data acquisition and display'),
('EE311','Power semiconductor devices|Phase controlled rectifiers|DC-DC choppers|Inverters|AC voltage controllers and drives'),
('EE321','System modeling and transfer functions|Time response|Stability analysis|Root locus and frequency response|Compensators and state space'),
('EE331','Power system overview and generation|Transmission line parameters|Performance of lines|Cables and insulators|Per unit system and load flow basics'),
('EE411','Three phase induction motors|Induction motor control|Synchronous generators|Synchronous motors|Special machines'),
('EE415','EV architecture and history|Batteries and energy storage|Electric motors for EVs|Charging infrastructure|Hybrid vehicles and control'),
('EE421','Load flow studies|Fault analysis|Symmetrical components|Stability basics|Economic operation'),
('EE425','Smart grid concepts|Smart metering and communication|Distributed generation and microgrids|Demand response|Cyber security and standards'),
('EE431','Circuit breakers|Protective relays|Generator and transformer protection|Line and busbar protection|Overvoltage protection and substations'),
('EE510','Advanced converters|Resonant converters|Multilevel inverters|Motor drives|Power quality and applications'),
('EE520','Stability concepts|Swing equation and rotor angle stability|Voltage stability|Small signal stability|Stability enhancement'),
('EE530','Breakdown in gases|Breakdown in liquids and solids|High voltage generation|Measurement of high voltages|Testing and insulation coordination'),
('EE540','Energy scenario and policy|Energy auditing|Energy efficient equipment|Demand side management|Renewable integration and economics'),
('EEH1','HVDC history and converters|Converter control|Harmonics and filters|HVDC protection and faults|Multi-terminal HVDC and VSC'),
('EEH2','Storage technologies overview|Battery storage systems|Pumped hydro, flywheels and hydrogen|Power conversion and grid integration|Economics and applications'),
('EEO1','Energy sources and scenario|Energy audit methodology|Efficiency in electrical systems|Thermal energy conservation|Energy economics and policy'),
-- ENTC
('ENTC111','Semiconductor physics and diodes|BJT characteristics|BJT amplifiers|FET and MOSFET|Rectifiers and regulators'),
('ENTC121','Network theorems|Transient response|Laplace transform analysis|Two-port networks|Network synthesis and filters'),
('ENTC131','Number systems and logic gates|Combinational design|Sequential logic|State machines|Programmable logic and HDL basics'),
('ENTC211','Signal classification and operations|LTI systems and convolution|Fourier series and transform|Laplace transform|Z-transform and sampling'),
('ENTC221','Amplifier frequency response|Feedback amplifiers|Oscillators|Op-amp applications|Waveform generators and filters'),
('ENTC231','Vector analysis and electrostatics|Magnetostatics|Maxwell equations|Plane wave propagation|Transmission lines and waveguides'),
('ENTC311','Sampling and PCM|Baseband transmission|Digital modulation|Information theory|Error control coding'),
('ENTC321','8051 architecture|Assembly and embedded C|Timers and interrupts|Serial communication|Interfacing and applications'),
('ENTC331','Control system modeling|Time domain analysis|Stability|Frequency domain analysis|State variable analysis'),
('ENTC411','Discrete time signals and systems|DFT and FFT|IIR filter design|FIR filter design|Multirate and DSP processors'),
('ENTC415','IoT architecture and sensors|Embedded platforms|Communication protocols|IoT cloud and data|IoT applications and security'),
('ENTC421','MOS device fundamentals|CMOS logic design|Combinational and sequential CMOS circuits|HDL and FPGA design|Layout, testing and fabrication'),
('ENTC425','Orbital mechanics|Satellite subsystems|Link design|Multiple access techniques|Satellite applications such as GPS and VSAT'),
('ENTC431','Wireless channel and propagation|Cellular concepts|Multiple access and diversity|OFDM and MIMO|Wireless standards from 4G to 5G'),
('ENTC510','Multirate systems and filter banks|Adaptive filters|Spectral estimation|Wavelets|Applications of DSP'),
('ENTC520','Transmission line theory and Smith chart|Microwave network analysis|Passive components|Active RF circuits|Antennas and measurements'),
('ENTC530','Embedded architecture and ARM|Real time operating systems|Peripheral interfacing|Low power and system design|Embedded protocols and case studies'),
('ENTC540','Optical fiber basics|Signal degradation|Sources and detectors|Optical systems and WDM|Optical networks and amplifiers'),
('ENTCH1','Evolution beyond 5G|Terahertz and mmWave|Massive MIMO and RIS|AI native networks|6G applications and challenges'),
('ENTCH2','Brain inspired computing|Spiking neural networks|Memristors and devices|Neuromorphic architectures|Applications and benchmarks'),
('ENTCO1','Audio systems and devices|Television and video systems|Home appliances|Mobile and wearable devices|Smart home and emerging gadgets'),
-- IT
('IT111','Python basics|Control flow and functions|Data structures in Python|Files, modules and exceptions|OOP and libraries'),
('IT121','Computer hardware and software|Operating systems and networks basics|Internet and web basics|Databases and information systems|Emerging technologies'),
('IT131','HTML and CSS|JavaScript basics|DOM and events|Responsive design|Web hosting and basic server side'),
('IT211','Arrays and linked lists|Stacks and queues|Trees|Graphs|Sorting, searching and hashing'),
('IT221','Object oriented concepts|UML modeling|Use cases and analysis|Design patterns|Implementation and testing'),
('IT231','Network fundamentals and models|Data link and LAN|Network layer and routing|Transport layer|Application layer and security basics'),
('IT311','Processes and threads|CPU scheduling|Synchronization and deadlocks|Memory management|File systems and security'),
('IT321','Relational model and SQL|Normalization|Transactions|Concurrency and recovery|Indexing and NoSQL introduction'),
('IT331','Software process models|Requirements engineering|Software design|Testing and quality|Project management and maintenance'),
('IT411','IoT fundamentals and architecture|Sensors and actuators|Connectivity and protocols|Cloud and data analytics|IoT applications and security'),
('IT415','DevOps culture and SDLC|Version control and CI|Containers and Docker|Kubernetes and orchestration|Monitoring and infrastructure as code'),
('IT421','Security basics and threats|Cryptography|Network security|Web and application security|Incident response and compliance'),
('IT425','Blockchain basics and cryptography|Consensus mechanisms|Smart contracts|Ethereum and Hyperledger|Blockchain applications'),
('IT431','Mobile platforms and UI design|Activities and layouts|Data storage and networking|Sensors and background services|Testing and publishing apps'),
('IT510','Query processing and optimization|Advanced transactions|Distributed databases|NoSQL and NewSQL|Data warehousing and big data'),
('IT520','Cloud design principles|Compute and storage services|Networking and security|Microservices and serverless|Cost, scaling and migration'),
('IT530','Secure software development lifecycle|Threat modeling|Secure coding|Security testing|Deployment and incident handling'),
('IT540','Project initiation and scope|Scheduling and estimation|Risk and quality management|Agile and Scrum|Project closure and metrics'),
('ITH1','Forensics fundamentals and law|Disk and file system forensics|Network forensics|Mobile and cloud forensics|Evidence reporting and anti-forensics'),
('ITH2','Qubits and quantum gates|Quantum circuits|Quantum algorithms|Quantum error correction|Quantum hardware and applications'),
('ITO1','E-commerce models and architecture|Web and mobile commerce|Electronic payments|Security and legal issues|Digital marketing and trends'),
-- MECH
('MECH111','Drawing standards and projections|Orthographic projection|Sections and development|Isometric views|Introduction to CAD drafting'),
('MECH121','Force systems and equilibrium|Friction|Centroid and moment of inertia|Kinematics of particles|Kinetics and work-energy'),
('MECH131','Workshop safety and measuring tools|Carpentry and fitting|Welding and sheet metal|Machining basics|Foundry and smithy'),
('MECH211','Basic concepts and zeroth law|First law|Second law and entropy|Properties of pure substances|Gas power cycles'),
('MECH221','Stress and strain|Bending and shear|Torsion|Deflection of beams|Columns and thin cylinders'),
('MECH231','Fluid properties and statics|Fluid kinematics|Fluid dynamics|Flow through pipes|Boundary layer and introduction to turbomachines'),
('MECH311','Mechanisms and kinematics|Velocity and acceleration analysis|Cams|Gears and gear trains|Balancing and vibrations'),
('MECH321','Casting|Forming processes|Welding|Machining processes|Metrology and unconventional machining'),
('MECH331','Conduction|Fins and transient conduction|Convection|Radiation|Heat exchangers'),
('MECH411','Design principles and materials|Design for static loads|Fatigue design|Shafts, keys and couplings|Gears, bearings and springs'),
('MECH415','Robot anatomy and kinematics|Inverse kinematics and dynamics|Sensors and actuators|Trajectory planning and control|Robot programming and applications'),
('MECH421','CAD fundamentals|Geometric modeling|CNC machines|CAM and part programming|Automation and CIM'),
('MECH425','Vehicle layout and engines|Transmission systems|Steering, brakes and suspension|Electrical systems|Emissions and modern trends'),
('MECH431','Introduction and weighted residual methods|One dimensional elements|Two dimensional elements|Isoparametric formulation|Dynamic and thermal analysis'),
('MECH510','Advanced machining processes|Micro and nano manufacturing|Process planning and automation|Quality and lean manufacturing|Smart manufacturing'),
('MECH520','IC engines|Gas turbines and jet propulsion|Refrigeration|Air conditioning|Steam power systems'),
('MECH530','Optimization fundamentals|Single variable methods|Multivariable methods|Constrained optimization|Design applications'),
('MECH540','Mechatronic systems overview|Sensors and signal conditioning|Actuators|Microcontrollers and PLCs|System integration and control'),
('MECHH1','AM principles and history|Material extrusion and vat photopolymerization|Powder bed and metal AM|Design for AM|Post-processing and applications'),
('MECHH2','Aerothermodynamics basics|Gas turbine engines|Jet engine components|Rocket propulsion|Propulsion performance and emerging trends'),
('MECHO1','Industrial hazards and safety|Accident analysis and legal framework|Fire and chemical safety|Environmental management|Safety management systems')
)
INSERT INTO course_unit (course_id, unit_no, unit_title, planned_lectures)
SELECT c.course_id, u.n::smallint, left(u.title, 150),
       CASE WHEN c.lecture_hrs >= 4 THEN 11
            WHEN c.lecture_hrs >= 1 THEN 9
            WHEN c.credits >= 1.5     THEN 4
            ELSE 3 END
FROM course c
CROSS JOIN LATERAL unnest(
  CASE
    WHEN c.lecture_hrs > 0 THEN (SELECT string_to_array(t.titles, '|') FROM theory t WHERE t.code = c.course_code)
    WHEN c.credits >= 1.5  THEN ARRAY['Basic experiments - ' || c.course_name,
                                      'Core experiments - ' || c.course_name,
                                      'Intermediate experiments - ' || c.course_name,
                                      'Advanced experiments - ' || c.course_name,
                                      'Mini project and viva - ' || c.course_name]
    ELSE                        ARRAY['Problem set 1 - Foundations of ' || c.course_name,
                                      'Problem set 2 - Core methods',
                                      'Problem set 3 - Applications',
                                      'Problem set 4 - Extended problems',
                                      'Problem set 5 - Revision and test practice']
  END
) WITH ORDINALITY AS u(title, n)
ON CONFLICT (course_id, unit_no) DO NOTHING;

-- Every course must now have exactly five units (this catches a course code missing from the list above).
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM course c
  WHERE (SELECT count(*) FROM course_unit u WHERE u.course_id = c.course_id) <> 5;
  IF bad > 0 THEN
    RAISE EXCEPTION '043: % course(s) do not have 5 units', bad;
  END IF;
END $$;
